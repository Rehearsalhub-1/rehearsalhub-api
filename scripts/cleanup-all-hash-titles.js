const dotenv = require('dotenv');
dotenv.config({ path: 'c:/Users/Eric/Pictures/workholiday/rehearsalhub-api/.env' });
const { Client } = require('pg');

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('Fetching media assets with raw hash titles...');
  const res = await client.query(`
    SELECT id, title, url, size, created_at, mime_type, type
    FROM media_assets
    WHERE title ~ '^[a-z0-9_-]{15,35}$'
    ORDER BY created_at ASC
  `);

  console.log(`Found ${res.rows.length} assets with raw hash titles to rename.\n`);

  // Explicitly known song matches from Whisper audio transcription
  const knownMatches = {
    'j6iry7svtumnjmr3sati': 'LORD OF GLORY (Rehearsal Track)',
    'wds3jznhriueqeyw0nxn': 'OH, HOW YOU LOVE ME SO (Rehearsal Track)',
    'ksxitcwikvydnxmcmgog': 'HOLY GOD (Rehearsal Track)',
    'fvllammlbmrh69auft6x': 'HOLY GOD (Rehearsal Take 2)',
  };

  let updatedCount = 0;
  // Group by date to provide clean sequential numbers per day
  const dateCounters = {};

  for (const row of res.rows) {
    const hash = row.title.trim();
    let newTitle = '';

    if (knownMatches[hash]) {
      newTitle = knownMatches[hash];
    } else {
      const d = row.created_at ? new Date(row.created_at) : new Date();
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateStr = `${monthNames[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
      
      const dayKey = dateStr;
      dateCounters[dayKey] = (dateCounters[dayKey] || 0) + 1;
      const count = dateCounters[dayKey];
      const countStr = count < 10 ? `0${count}` : `${count}`;

      const sizeMb = row.size ? (Number(row.size) / (1024 * 1024)).toFixed(1) : null;
      const sizeLabel = sizeMb ? ` - ${sizeMb}MB` : '';

      const isAudio = (row.mime_type && row.mime_type.startsWith('audio/')) || row.type === 'audio' || row.url.endsWith('.mp3');
      const isImage = (row.mime_type && row.mime_type.startsWith('image/')) || row.type === 'image';
      const isVideo = (row.mime_type && row.mime_type.startsWith('video/')) || row.type === 'video';

      const typeLabel = isAudio ? 'Rehearsal Audio' : isImage ? 'Media Photo' : isVideo ? 'Rehearsal Video' : 'Choir Resource';

      newTitle = `${typeLabel} ${dateStr} #${countStr}${sizeLabel}`;
    }

    await client.query(`
      UPDATE media_assets 
      SET title = $1, 
          updated_at = NOW()
      WHERE id = $2
    `, [newTitle, row.id]);

    console.log(`[${++updatedCount}/${res.rows.length}] Renamed "${hash}" -> "${newTitle}"`);
  }

  console.log(`\n🎉 Successfully cleaned up and renamed all ${updatedCount} hash titles in media_assets!`);

  const remaining = await client.query(`
    SELECT count(*) FROM media_assets WHERE title ~ '^[a-z0-9_-]{15,35}$'
  `);
  console.log(`Remaining raw hash titles in DB: ${remaining.rows[0].count}`);

  await client.end();
}

run().catch(console.error);
