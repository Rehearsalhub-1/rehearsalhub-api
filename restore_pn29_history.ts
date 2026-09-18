import { Client } from 'pg';
import 'dotenv/config';

interface SongTarget {
  id: string;
  title: string;
  copyCommentsFrom?: string[];
}

const TARGET_SONGS: SongTarget[] = [
  { id: 'song-1789484950735', title: 'PROPOSED MEDLEY 24' },
  { id: 'song-1789483060444', title: 'GOD OF ALL POSSIBILITIES', copyCommentsFrom: ['stRd7j0aE4C08cAWXLLh'] },
  { id: 'song-1789577564615', title: 'MY GLORIOUS AND LOVING FATHER', copyCommentsFrom: ['bQp0DrLuhEY43xYh86TE'] },
  { id: 'song-1789485040331', title: 'WE ARE IN YOU', copyCommentsFrom: ['793CHWdxPhL9kIwUyBub', 'GGMswYLpPHdTpkZuLQBK'] },
  { id: 'song-1789484808521', title: 'GLORIOUS KING ENTHRONED' },
  { id: 'song-1789484595534', title: 'I STAND IN AWE' },
  { id: 'song-1789485475591', title: 'THANK YOU HOLY SPIRIT' },
  { id: 'song-1789487804922', title: 'YOU ARE BEAUTIFUL' },
  { id: 'song-1789492897682', title: 'YOU ARE THE FATHER OF LIGHT' },
  { id: 'song-1789577204238', title: 'HALLELUJAH CHANT' },
  { id: 'song-1789577274989', title: "IT'S A PRIVILEGE", copyCommentsFrom: ['HsPw8CVpRatXTmuD6SYR'] },
  { id: 'song-1789485886332', title: 'THE MOST SUBLIME IDENTITY' },
  { id: 'song-1789666141214', title: 'THESE LAST DAYS', copyCommentsFrom: ['REATPJEZCtGbLxzTZecX', 'J4cNWd2yv8i6clrr5Twd'] },
];

function genId(prefix = 'cmu_hist'): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${ts}_${rnd}`;
}

async function restore() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 90000,
    query_timeout: 45000,
  });

  console.log('Connecting to PostgreSQL database...');
  await client.connect();
  console.log('Connected successfully!\n');

  let totalInserted = 0;

  for (const target of TARGET_SONGS) {
    console.log(`\n======================================================`);
    console.log(`Processing: "${target.title}" (PN29 ID: ${target.id})`);

    // Fetch the song details from DB
    const sRes = await client.query(`
      SELECT id, title, key, tempo, lead_singer, conductor, lyrics, audio_file, audio_urls, created_at
      FROM songs
      WHERE id = $1
    `, [target.id]);

    if (sRes.rows.length === 0) {
      console.log(`  [WARN] Song with ID ${target.id} not found in DB!`);
      continue;
    }

    const song = sRes.rows[0];

    // 1. Restore/Insert Rehearsal Audio Entry
    if (song.audio_file) {
      const existingAudio = await client.query(`
        SELECT id FROM song_history
        WHERE song_id = $1 AND (new_value = $2 OR type = 'audio')
      `, [song.id, song.audio_file]);

      if (existingAudio.rows.length === 0) {
        const titleDesc = `MOST UPDATED REHEARSAL (${song.title})`;
        const notesDesc = `Recorded Rehearsal - ${song.lead_singer || 'Loveworld Singers'}`;
        const descJson = JSON.stringify({ title: titleDesc, notes: notesDesc });
        const histId = genId('cmu_aud');

        await client.query(`
          INSERT INTO song_history (id, song_id, type, description, old_value, new_value, created_at)
          VALUES ($1, $2, 'audio', $3, $4, $5, NOW())
        `, [histId, song.id, descJson, song.audio_file, song.audio_file]);

        console.log(`  [+] Inserted Audio History: "${titleDesc}" -> ${song.audio_file.slice(0, 60)}...`);
        totalInserted++;
      } else {
        console.log(`  [=] Audio History already present (${existingAudio.rows.length} rows)`);
      }
    }

    // 2. Restore/Insert Lyrics History
    if (song.lyrics && song.lyrics.trim().length > 0) {
      const existingLyrics = await client.query(`
        SELECT id FROM song_history
        WHERE song_id = $1 AND type = 'lyrics'
      `, [song.id]);

      if (existingLyrics.rows.length === 0) {
        const descJson = JSON.stringify({
          title: 'Most Updated Lyrics Version',
          notes: `Praise Night 29 Lyrics (${song.lyrics.length} chars)`
        });
        const histId = genId('cmu_lyr');

        await client.query(`
          INSERT INTO song_history (id, song_id, type, description, old_value, new_value, created_at)
          VALUES ($1, $2, 'lyrics', $3, $4, $5, NOW())
        `, [histId, song.id, descJson, song.lyrics, song.lyrics]);

        console.log(`  [+] Inserted Lyrics History: "${song.title}" (${song.lyrics.length} chars)`);
        totalInserted++;
      } else {
        console.log(`  [=] Lyrics History already present`);
      }
    }

    // 3. Restore/Insert Song Details / Metadata History
    const existingDetails = await client.query(`
      SELECT id FROM song_history
      WHERE song_id = $1 AND type IN ('details', 'metadata', 'music-details', 'song-details')
    `, [song.id]);

    if (existingDetails.rows.length === 0) {
      const metaSummary = `Lead: ${song.lead_singer || 'Loveworld Singers'} | Key: ${song.key || 'N/A'} | Tempo: ${song.tempo || 'N/A'}`;
      const descJson = JSON.stringify({
        title: 'Song Details',
        notes: metaSummary
      });
      const histId = genId('cmu_det');

      await client.query(`
        INSERT INTO song_history (id, song_id, type, description, old_value, new_value, created_at)
        VALUES ($1, $2, 'details', $3, '', $4, NOW())
      `, [histId, song.id, descJson, metaSummary]);

      console.log(`  [+] Inserted Song Details History: ${metaSummary}`);
      totalInserted++;
    }

    // 4. Copy Pastor's Rehearsal Comments if applicable
    if (target.copyCommentsFrom && target.copyCommentsFrom.length > 0) {
      for (const sourceSongId of target.copyCommentsFrom) {
        const commentsRes = await client.query(`
          SELECT sh.type, sh.description, sh.old_value, sh.new_value, sh.created_at
          FROM song_history sh
          WHERE sh.song_id = $1 AND (sh.type ILIKE '%comment%' OR sh.description ILIKE '%pastor%' OR sh.description ILIKE '%instruction%' OR sh.description ILIKE '%rehearsal%')
        `, [sourceSongId]);

        for (const comm of commentsRes.rows) {
          // Check if already copied
          const dupCheck = await client.query(`
            SELECT id FROM song_history
            WHERE song_id = $1 AND description = $2
          `, [song.id, comm.description]);

          if (dupCheck.rows.length === 0) {
            const histId = genId('cmu_com');
            await client.query(`
              INSERT INTO song_history (id, song_id, type, description, old_value, new_value, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [histId, song.id, comm.type || 'comments', comm.description, comm.old_value || '', comm.new_value || '', comm.created_at || new Date()]);

            console.log(`  [+] Copied Pastor Rehearsal Comment from ${sourceSongId}: "${(comm.description || '').slice(0, 50)}..."`);
            totalInserted++;
          }
        }
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(`RESTORE COMPLETED: Inserted ${totalInserted} history entries across all 13 PN29 songs!`);
  console.log(`======================================================\n`);

  // Verification: Count history for all 15 songs in PN29
  console.log('--- Current History Counts for PN29 Songs ---');
  const verifyRes = await client.query(`
    SELECT s.id, s.title, COUNT(sh.id) as history_count
    FROM songs s
    LEFT JOIN song_history sh ON sh.song_id = s.id
    WHERE s.id IN ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'zyXEm1x1fXsQ07CiUA8x')
    GROUP BY s.id, s.title
    ORDER BY s.title ASC
  `, TARGET_SONGS.map(t => t.id));

  verifyRes.rows.forEach(r => {
    console.log(`  ${r.title.padEnd(38)} (id=${r.id}) -> ${r.history_count} entries ✅`);
  });

  await client.end();
}

restore().catch(err => {
  console.error('Restoration error:', err);
  process.exit(1);
});
