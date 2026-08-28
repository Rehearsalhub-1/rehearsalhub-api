import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  console.log('--- Syncing Song Personnel & Columns from raw_data ---');

  // 1. Sync songs table
  const sRes = await sql`
    UPDATE songs
    SET 
      lead_singer = COALESCE(NULLIF(lead_singer, ''), NULLIF(raw_data->>'leadSinger', ''), NULLIF(raw_data->>'lead_singer', ''), ''),
      conductor = COALESCE(NULLIF(conductor, ''), NULLIF(raw_data->>'conductor', ''), ''),
      drummer = COALESCE(NULLIF(drummer, ''), NULLIF(raw_data->>'drummer', ''), ''),
      writer = COALESCE(NULLIF(writer, ''), NULLIF(raw_data->>'writer', ''), NULLIF(raw_data->>'songWriter', ''), ''),
      key = COALESCE(NULLIF(key, ''), NULLIF(raw_data->>'key', ''), ''),
      tempo = COALESCE(NULLIF(tempo, ''), NULLIF(raw_data->>'tempo', ''), '')
    WHERE raw_data IS NOT NULL;
  `;
  console.log('Synced songs records:', sRes.count);

  // 2. Sync ministered_songs table
  const mRes = await sql`
    UPDATE ministered_songs
    SET 
      lead_singer = COALESCE(NULLIF(lead_singer, ''), NULLIF(raw_data->>'leadSinger', ''), NULLIF(raw_data->>'lead_singer', ''), ''),
      conductor = COALESCE(NULLIF(conductor, ''), NULLIF(raw_data->>'conductor', ''), ''),
      writer = COALESCE(NULLIF(writer, ''), NULLIF(raw_data->>'writer', ''), ''),
      key = COALESCE(NULLIF(key, ''), NULLIF(raw_data->>'key', ''), ''),
      tempo = COALESCE(NULLIF(tempo, ''), NULLIF(raw_data->>'tempo', ''), '')
    WHERE raw_data IS NOT NULL;
  `;
  console.log('Synced ministered_songs records:', mRes.count);

  // 3. Verify non-empty lead_singers count
  const [songsWithLead, minWithLead] = await Promise.all([
    sql`SELECT count(*) as total, count(*) FILTER (WHERE lead_singer != '') as has_lead FROM songs;`,
    sql`SELECT count(*) as total, count(*) FILTER (WHERE lead_singer != '') as has_lead FROM ministered_songs;`,
  ]);

  console.log('Songs lead_singer count:', songsWithLead[0]);
  console.log('Ministered songs lead_singer count:', minWithLead[0]);

  process.exit(0);
}

main().catch(console.error);
