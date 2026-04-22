require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL não definida no .env (ex: postgresql://user:senha@localhost:5432/matriz)');
}

module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  portaHttp: parseInt(process.env.PORT || '8080', 10),
};
