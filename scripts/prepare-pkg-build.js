/**
 * Prepara .pkg-build/ — uma cópia de src/ com os requires de subpath imports (#server/...,
 * #client/...) reescritos para caminhos relativos literais — antes de rodar o pkg.
 *
 * Por quê: pkg (e o fork @yao-pkg/pkg que este projeto usa) não entende o campo "imports" do
 * package.json — o resolvedor de módulos embutido no executável espera um literal require()
 * relativo/absoluto, não um subpath import. Com os aliases, o build emite warnings
 * "Cannot find module '#server/...'" e o .exe gerado quebra em runtime com o mesmo erro assim
 * que tenta carregar qualquer rota (confirmado rodando o binário de verdade). Aliases nativos
 * do Node continuam funcionando normalmente fora do pkg (node src/server.js, Jest, nodemon).
 *
 * A reescrita não precisa recalcular nada em cima da estrutura copiada: como .pkg-build/src/
 * espelha src/ 1:1, o caminho relativo entre dois arquivos é idêntico nos dois lugares — dá
 * pra calcular tudo em cima dos caminhos originais em src/ e só copiar o resultado.
 *
 * node_modules não é copiado (seria lento e pesado) — é uma junction do Windows apontando pro
 * node_modules real, que o pkg consegue atravessar normalmente pra resolver as dependências.
 */

const fs = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..');
const SRC        = path.join(ROOT, 'src');
const STAGE      = path.join(ROOT, '.pkg-build');
const STAGE_SRC  = path.join(STAGE, 'src');

const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const importsMap = pkgJson.imports || {};

// Resolve um specifier tipo '#server/infrastructure/db.js' pro caminho absoluto que ele
// mapeia em src/, usando o próprio campo "imports" do package.json (padrões terminados em /*).
function resolverAliasParaAbsoluto(specifier) {
  for (const [padrao, alvo] of Object.entries(importsMap)) {
    if (!padrao.endsWith('/*') || !alvo.endsWith('/*')) continue;
    const prefixo = padrao.slice(0, -1); // '#server/'
    if (!specifier.startsWith(prefixo)) continue;
    const resto = specifier.slice(prefixo.length);
    const alvoPrefixo = alvo.slice(0, -1).replace(/^\.\//, ''); // 'src/server/'
    return path.resolve(ROOT, alvoPrefixo + resto);
  }
  return null;
}

const REQUIRE_ALIAS_RE = /require\((['"])(#[^'"]+)\1\)/g;

function reescreverConteudo(absArquivoOriginal, conteudo) {
  return conteudo.replace(REQUIRE_ALIAS_RE, (match, aspas, specifier) => {
    const alvoAbs = resolverAliasParaAbsoluto(specifier);
    if (!alvoAbs) return match; // specifier desconhecido — deixa como está, não é nosso alias
    let rel = path.relative(path.dirname(absArquivoOriginal), alvoAbs).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `require(${aspas}${rel}${aspas})`;
  });
}

function copiarDiretorio(dirOrigem, dirDestino) {
  fs.mkdirSync(dirDestino, { recursive: true });
  for (const entry of fs.readdirSync(dirOrigem, { withFileTypes: true })) {
    const origemAbs  = path.join(dirOrigem, entry.name);
    const destinoAbs = path.join(dirDestino, entry.name);
    if (entry.isDirectory()) {
      copiarDiretorio(origemAbs, destinoAbs);
    } else if (entry.name.endsWith('.js')) {
      const conteudo = fs.readFileSync(origemAbs, 'utf8');
      fs.writeFileSync(destinoAbs, reescreverConteudo(origemAbs, conteudo), 'utf8');
    } else {
      fs.copyFileSync(origemAbs, destinoAbs);
    }
  }
}

fs.rmSync(STAGE, { recursive: true, force: true });
copiarDiretorio(SRC, STAGE_SRC);

// package.json staged: sem "imports" (não é mais necessário — tudo já virou relativo).
const pkgStaged = { ...pkgJson };
delete pkgStaged.imports;
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(pkgStaged, null, 2), 'utf8');

// node_modules como junction — evita copiar centenas de MB, e o pkg atravessa normalmente.
const nodeModulesOrigem  = path.join(ROOT, 'node_modules');
const nodeModulesDestino = path.join(STAGE, 'node_modules');
if (fs.existsSync(nodeModulesOrigem)) {
  fs.symlinkSync(nodeModulesOrigem, nodeModulesDestino, 'junction');
} else {
  console.warn('[prepare-pkg-build] node_modules não encontrado em ' + ROOT + ' — rode npm install antes de compilar.');
}

console.log(`[prepare-pkg-build] Staged em ${STAGE}`);
