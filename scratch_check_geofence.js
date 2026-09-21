require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.DATABASE_DIRECT_URL,
    ssl: { rejectUnauthorized: false }
  });

  const res = await pool.query("SELECT key, value FROM settings");
  console.log('ALL rows in settings table:');
  console.log(JSON.stringify(res.rows, null, 2));

  await pool.end();
}

main().catch(console.error);
