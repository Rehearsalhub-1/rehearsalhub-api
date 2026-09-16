const { Client } = require('pg');
require('dotenv').config({ path: __dirname + '/../.env' });

async function verify() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const res = await client.query(`
    SELECT id, title, type, created_at 
    FROM media_assets 
    ORDER BY created_at DESC 
    LIMIT 20
  `);
  console.log('--- RECENT 20 MEDIA ASSETS ---');
  for (const r of res.rows) {
    console.log(`[${r.type}] ${r.title} (${r.id})`);
  }

  const hashCount = await client.query(`
    SELECT COUNT(*) as cnt 
    FROM media_assets 
    WHERE title ~ '^[a-z0-9_-]{15,35}$'
  `);
  console.log('\nAny remaining raw hashes:', hashCount.rows[0].cnt);
  await client.end();
}

verify().catch(console.error);
