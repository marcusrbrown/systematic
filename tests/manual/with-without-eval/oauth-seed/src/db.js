const { Pool } = require('pg')

// Reads DATABASE_URL if set; falls back to standard PG* environment variables.
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : undefined,
)

module.exports = { pool }
