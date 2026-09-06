const { Pool } = require('pg');

// Render Postgres gives you a DATABASE_URL - set it as an env var on the Render web service.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

module.exports = { pool };
