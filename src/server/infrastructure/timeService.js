/**
 * Retorna a hora atual do servidor.
 * Interface mantida assíncrona para compatibilidade com os chamadores.
 *
 * @returns {Promise<Date>}
 */
async function getCurrentTime() {
  return new Date();
}

module.exports = { getCurrentTime };
