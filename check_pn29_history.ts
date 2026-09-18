/**
 * Raw pg connection — bypasses Prisma pool, directly queries Railway DB
 * to find history for the PN29 songs.
 */
import { Client } from 'pg';
import 'dotenv/config';

const SONG_TITLES = [
  'PROPOSED MEDLEY 24',
  'GOD OF ALL POSSIBILITIES',
  'MY GLORIOUS AND LOVING FATHER',
  'WE ARE IN YOU',
  'GLORIOUS KING ENTHRONED',
  'I STAND IN AWE',
  'THANK YOU HOLY SPIRIT',
  'YOU ARE BEAUTIFUL',
  'BLESSED LAMB',
  'YOU ARE THE FATHER OF LIGHT',
  'SPIRIT OF THE LIVING GOD',
  'HALLELUJAH CHANT',
  "IT'S A PRIVILEGE",
  'THE MOST SUBLIME IDENTITY',
  'THESE LAST DAYS',
];

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 90000,
    query_timeout: 45000,
  });

  await client.connect();
  console.log('Connected to DB!\n');

  // 1. Total song_history count
  const countRes = await client.query('SELECT COUNT(*) FROM song_history');
  console.log(`Total song_history rows in DB: ${countRes.rows[0].count}`);

  // 2. All programs in the DB
  const progRes = await client.query('SELECT id, name, category, created_at, is_active, is_archived FROM programs ORDER BY created_at DESC');
  console.log(`\nAll programs in DB (${progRes.rows.length}):`);
  progRes.rows.forEach(p => console.log(`  id=${p.id} name="${p.name}" cat=${p.category} created=${p.created_at?.toISOString()} active=${p.is_active} arch=${p.is_archived}`));

  console.log('\n--- Inspecting BLESSED LAMB PN29 history rows ---');
  const blRes = await client.query(`
    SELECT * FROM song_history
    WHERE song_id = 'zyXEm1x1fXsQ07CiUA8x'
    ORDER BY created_at DESC
  `);
  blRes.rows.forEach(r => console.log(' ', JSON.stringify(r)));

  // 5. Does the songs table have history in a column? Check columns of songs table
  console.log('\n--- Columns of songs table ---');
  const cols = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'songs'
  `);
  cols.rows.forEach(c => console.log(`  ${c.column_name} (${c.data_type})`));

  await client.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
