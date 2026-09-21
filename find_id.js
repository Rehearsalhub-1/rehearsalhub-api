require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.DATABASE_DIRECT_URL,
    ssl: { rejectUnauthorized: false }
  });

  const id = 'cm7znf00300008wyhghd1400v';
  console.log('Searching for ID:', id);

  const orgs = await pool.query('SELECT * FROM organizations WHERE id = $1', [id]);
  console.log('In organizations:', orgs.rows);

  const groups = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);
  console.log('In groups:', groups.rows);

  const settings = await pool.query('SELECT * FROM settings WHERE key LIKE $1', ['%' + id + '%']);
  console.log('In settings:', settings.rows);

  await pool.end();
}

main().catch(console.error);
