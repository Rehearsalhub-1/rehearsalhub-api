import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  console.log('=== INSPECTING SONG FIELDS IN DATABASE ===');

  // 1. Get all column names for songs
  const cols = await sql`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'songs';
  `;
  console.log('\nColumns in "songs" table:');
  cols.forEach(c => console.log(`  - ${c.column_name} (${c.data_type})`));

  // 2. Discover all distinct keys in raw_data JSONB across all songs
  const rawKeys = await sql`
    SELECT DISTINCT jsonb_object_keys(raw_data) as key
    FROM songs
    WHERE raw_data IS NOT NULL AND raw_data != '{}'::jsonb;
  `;
  console.log('\nAll distinct keys found inside songs.raw_data JSONB:');
  console.log(rawKeys.map(r => r.key).sort());

  // 3. Check lead singer variations
  const leadSingerStats = await sql`
    SELECT 
      count(*) as total,
      count(*) FILTER (WHERE raw_data->>'leadSinger' IS NOT NULL AND raw_data->>'leadSinger' != '') as has_camel_leadSinger,
      count(*) FILTER (WHERE raw_data->>'lead_singer' IS NOT NULL AND raw_data->>'lead_singer' != '') as has_snake_lead_singer,
      count(*) FILTER (WHERE raw_data->>'lead' IS NOT NULL AND raw_data->>'lead' != '') as has_lead,
      count(*) FILTER (WHERE raw_data->>'singer' IS NOT NULL AND raw_data->>'singer' != '') as has_singer,
      count(*) FILTER (WHERE raw_data->>'leadVocalist' IS NOT NULL AND raw_data->>'leadVocalist' != '') as has_leadVocalist,
      count(*) FILTER (WHERE raw_data->>'lead_vocalist' IS NOT NULL AND raw_data->>'lead_vocalist' != '') as has_snake_lead_vocalist,
      count(*) FILTER (WHERE raw_data->>'artist' IS NOT NULL AND raw_data->>'artist' != '') as has_artist
    FROM songs;
  `;
  console.log('\nLead Singer Field Counts:', leadSingerStats[0]);

  // 4. Check writer / author variations
  const writerStats = await sql`
    SELECT 
      count(*) as total,
      count(*) FILTER (WHERE writer IS NOT NULL AND writer != '') as col_writer,
      count(*) FILTER (WHERE raw_data->>'writer' IS NOT NULL AND raw_data->>'writer' != '') as raw_writer,
      count(*) FILTER (WHERE raw_data->>'song_writer' IS NOT NULL AND raw_data->>'song_writer' != '') as raw_song_writer,
      count(*) FILTER (WHERE raw_data->>'songWriter' IS NOT NULL AND raw_data->>'songWriter' != '') as raw_songWriter,
      count(*) FILTER (WHERE raw_data->>'author' IS NOT NULL AND raw_data->>'author' != '') as raw_author,
      count(*) FILTER (WHERE raw_data->>'composer' IS NOT NULL AND raw_data->>'composer' != '') as raw_composer
    FROM songs;
  `;
  console.log('\nWriter Field Counts:', writerStats[0]);

  // 5. Inspect 5 sample songs where leadSinger column or raw_data might be missing or under a different key
  const samples = await sql`
    SELECT 
      id, 
      title, 
      writer, 
      key, 
      tempo,
      raw_data
    FROM songs
    WHERE raw_data IS NOT NULL
    LIMIT 5;
  `;
  console.log('\n--- 5 Sample Songs raw_data Dumps ---');
  samples.forEach((s, idx) => {
    console.log(`\n[Song ${idx + 1}] Title: "${s.title}" (ID: ${s.id})`);
    console.log('Col writer:', s.writer, '| Col key:', s.key, '| Col tempo:', s.tempo);
    console.log('raw_data keys & values:');
    const raw = s.raw_data || {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.length > 80) {
        console.log(`  ${k}: "${v.substring(0, 80)}..."`);
      } else {
        console.log(`  ${k}:`, v);
      }
    }
  });

  process.exit(0);
}

main().catch(console.error);
