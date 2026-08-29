require('dotenv').config({ path: 'c:/Users/Eric/Pictures/workholiday/rehearsalhub-api/.env' });
const postgres = require('postgres');

const sql = postgres(process.env.DATABASE_URL);

async function check() {
  try {
    const tables = await sql`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_name ILIKE '%firebase%' 
         OR table_name ILIKE '%firestore%' 
         OR table_name ILIKE '%export%'
         OR table_name ILIKE '%media%'
         OR table_name ILIKE '%video%'
      ORDER BY table_schema, table_name
    `;
    console.log('=== Matching Tables Across All Schemas ===');
    console.log(tables);
    for (const t of mediaTables) {
      console.log(`\n--- TABLE: ${t.table_name} ---`);
      const cols = await sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = ${t.table_name} ORDER BY ordinal_position`;
      console.log('Columns:', cols.map(c => `${c.column_name} (${c.data_type})`).join(', '));

      try {
        const count = await sql`SELECT count(*) FROM ${sql(t.table_name)}`;
        console.log(`Row count: ${count[0].count}`);

        const sample = await sql`SELECT * FROM ${sql(t.table_name)} LIMIT 2`;
        console.log('Sample rows:', JSON.stringify(sample, null, 2));
      } catch (err) {
        console.log('Could not select from table:', err.message);
      }
    }
  } catch (e) {
    console.error('DB error:', e);
  } finally {
    await sql.end();
  }
}

check();
