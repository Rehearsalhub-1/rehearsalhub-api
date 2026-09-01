/**
 * wire_relationships.ts
 *
 * Migrates Firebase-era JSON arrays into proper relational junction tables.
 *
 * What this does:
 *   1. programs.song_ids (JSON)   →  program_songs rows  (order preserved)
 *   2. songs.praise_night_id (FK) →  program_songs rows  (old reverse FK)
 *   3. playlists.song_ids (JSON)  →  playlist_items rows (order preserved)
 *
 * Uses BULK inserts (one query per program/playlist) — fast even over remote DBs.
 * Safe to run multiple times — all inserts use ON CONFLICT DO NOTHING / DO UPDATE.
 * Does NOT drop any columns — run cleanup_json_columns.sql separately after verifying.
 *
 * Usage:
 *   npx tsx scripts/wire_relationships.ts
 */

import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractSongIds(row: { song_ids?: any; songs?: any; raw_data?: any }): string[] {
  // Priority 1: song_ids column (clean array of IDs)
  if (Array.isArray(row.song_ids) && row.song_ids.length > 0) {
    return row.song_ids.map((s: any) => (typeof s === 'string' ? s : s?.id)).filter(Boolean);
  }
  // Priority 2: songs column (may be full objects or bare IDs)
  if (Array.isArray(row.songs) && row.songs.length > 0) {
    const ids = row.songs.map((s: any) => (typeof s === 'string' ? s : s?.id)).filter(Boolean);
    if (ids.length > 0) return ids;
  }
  // Priority 3: raw_data fallback (Firebase remnants)
  if (row.raw_data && typeof row.raw_data === 'object') {
    const raw = row.raw_data as Record<string, any>;
    const candidates = raw.songIds || raw.song_ids || raw.songs || raw.praiseNightSongs || [];
    if (Array.isArray(candidates) && candidates.length > 0) {
      return candidates.map((s: any) => (typeof s === 'string' ? s : s?.id)).filter(Boolean);
    }
  }
  return [];
}

/**
 * Bulk-upsert rows into a junction table in a single SQL statement.
 * Builds: INSERT INTO <table> (id, col_a, col_b, "order") VALUES (...), (...), ...
 *         ON CONFLICT (col_a, col_b) DO UPDATE SET "order" = EXCLUDED."order"
 */
async function bulkUpsertJunction(
  client: pg.PoolClient,
  table: 'program_songs' | 'playlist_items',
  parentCol: 'program_id' | 'playlist_id',
  childCol: 'song_id',
  parentId: string,
  songIds: string[],
): Promise<number> {
  if (songIds.length === 0) return 0;

  const values: any[] = [];
  const placeholders: string[] = [];
  let p = 1;

  for (let i = 0; i < songIds.length; i++) {
    placeholders.push(`(gen_random_uuid(), $${p++}, $${p++}, $${p++})`);
    values.push(parentId, songIds[i], i + 1);
  }

  await client.query(
    `INSERT INTO ${table} (id, ${parentCol}, ${childCol}, "order")
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (${parentCol}, ${childCol}) DO UPDATE
       SET "order" = EXCLUDED."order"`,
    values,
  );

  return songIds.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();

  try {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   WIRING SONG ↔ PROGRAM RELATIONSHIPS           ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // ─────────────────────────────────────────────────────────────────────
    // 0. Load all valid song IDs (to detect ghost references)
    // ─────────────────────────────────────────────────────────────────────
    const songsRes = await client.query<{ id: string }>('SELECT id FROM songs');
    const validSongIds = new Set<string>(songsRes.rows.map((s) => s.id));
    console.log(`✓ Loaded ${validSongIds.size} valid songs\n`);

    // ─────────────────────────────────────────────────────────────────────
    // 1. programs → program_songs  (BULK per program)
    // ─────────────────────────────────────────────────────────────────────
    console.log('── Step 1: programs → program_songs ──────────────');

    const programsRes = await client.query(`
      SELECT id, name, song_ids, songs, raw_data
      FROM programs
      WHERE song_ids IS NOT NULL
         OR songs    IS NOT NULL
         OR raw_data->>'songIds'  IS NOT NULL
         OR raw_data->>'song_ids' IS NOT NULL
    `);
    console.log(`  Found ${programsRes.rows.length} programs with embedded song data`);

    let progLinked = 0;
    let progSkipped = 0;
    let progGhost = 0;
    const ghostLog: { program: string; ghost_song_id: string }[] = [];

    await client.query('BEGIN');
    for (const program of programsRes.rows) {
      const allIds = extractSongIds(program);
      if (allIds.length === 0) { progSkipped++; continue; }

      // Separate valid from ghost IDs
      const validIds: string[] = [];
      for (const id of allIds) {
        if (validSongIds.has(id)) {
          validIds.push(id);
        } else {
          progGhost++;
          ghostLog.push({ program: program.name || program.id, ghost_song_id: id });
        }
      }

      if (validIds.length > 0) {
        progLinked += await bulkUpsertJunction(client, 'program_songs', 'program_id', 'song_id', program.id, validIds);
      }
    }
    await client.query('COMMIT');

    console.log(`  ✓ Links created:          ${progLinked}`);
    console.log(`  - Programs with no songs: ${progSkipped}`);
    console.log(`  - Ghost song refs:        ${progGhost}`);

    if (ghostLog.length > 0) {
      console.log('\n  Ghost references (song deleted, still in program JSON):');
      console.table(ghostLog.slice(0, 20));
      if (ghostLog.length > 20) console.log(`  ... and ${ghostLog.length - 20} more`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 2. songs.praise_night_id → program_songs  (single bulk query)
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n── Step 2: songs.praise_night_id → program_songs ─');

    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'songs' AND column_name = 'praise_night_id'
    `);

    if (colCheck.rows.length === 0) {
      console.log('  ℹ praise_night_id already removed — skipping');
    } else {
      const fkRes = await client.query<{ id: string; praise_night_id: string }>(`
        SELECT id, praise_night_id FROM songs WHERE praise_night_id IS NOT NULL
      `);
      console.log(`  Found ${fkRes.rows.length} songs with praise_night_id`);

      if (fkRes.rows.length > 0) {
        const values: any[] = [];
        const placeholders: string[] = [];
        let p = 1;
        for (const song of fkRes.rows) {
          if (!validSongIds.has(song.id)) continue;
          placeholders.push(`(gen_random_uuid(), $${p++}, $${p++})`);
          values.push(song.praise_night_id, song.id);
        }
        if (placeholders.length > 0) {
          await client.query(
            `INSERT INTO program_songs (id, program_id, song_id)
             VALUES ${placeholders.join(', ')}
             ON CONFLICT (program_id, song_id) DO NOTHING`,
            values,
          );
        }
        console.log(`  ✓ FK links migrated: ${placeholders.length}`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 3. playlists → playlist_items  (BULK per playlist)
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n── Step 3: playlists → playlist_items ────────────');

    const playlistsRes = await client.query(`
      SELECT id, title, song_ids, songs, raw_data
      FROM playlists
      WHERE song_ids IS NOT NULL OR songs IS NOT NULL
    `);
    console.log(`  Found ${playlistsRes.rows.length} playlists with embedded song data`);

    let plLinked = 0;
    let plGhost = 0;

    await client.query('BEGIN');
    for (const playlist of playlistsRes.rows) {
      const allIds = extractSongIds(playlist);
      const validIds = allIds.filter((id) => {
        if (validSongIds.has(id)) return true;
        plGhost++;
        return false;
      });
      if (validIds.length > 0) {
        plLinked += await bulkUpsertJunction(client, 'playlist_items', 'playlist_id', 'song_id', playlist.id, validIds);
      }
    }
    await client.query('COMMIT');

    console.log(`  ✓ Links created:   ${plLinked}`);
    console.log(`  - Ghost song refs: ${plGhost}`);

    // ─────────────────────────────────────────────────────────────────────
    // 4. Verification Report
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   VERIFICATION REPORT                           ║');
    console.log('╚══════════════════════════════════════════════════╝');

    const coverage = await client.query(`
      SELECT
        p.name AS program_name,
        jsonb_array_length(COALESCE(p.song_ids, '[]'::jsonb)) AS json_count,
        COUNT(ps.song_id) AS linked_count
      FROM programs p
      LEFT JOIN program_songs ps ON ps.program_id = p.id
      WHERE p.song_ids IS NOT NULL
      GROUP BY p.id, p.name, p.song_ids
      ORDER BY COUNT(ps.song_id) DESC
      LIMIT 20
    `);
    console.log('\nTop programs by linked songs:');
    console.table(coverage.rows);

    const mismatch = await client.query<{ mismatch_count: string }>(`
      SELECT count(*) AS mismatch_count FROM (
        SELECT p.id
        FROM programs p
        LEFT JOIN program_songs ps ON ps.program_id = p.id
        WHERE p.song_ids IS NOT NULL
        GROUP BY p.id, p.song_ids
        HAVING jsonb_array_length(COALESCE(p.song_ids, '[]'::jsonb)) != COUNT(ps.song_id)
      ) sub
    `);
    console.log(`\nPrograms with count mismatch (= ghost songs): ${mismatch.rows[0].mismatch_count}`);

    const totals = await client.query(`
      SELECT
        (SELECT count(*) FROM program_songs)  AS program_song_links,
        (SELECT count(*) FROM playlist_items) AS playlist_song_links,
        (SELECT count(*) FROM programs)       AS total_programs,
        (SELECT count(*) FROM songs)          AS total_songs,
        (SELECT count(*) FROM playlists)      AS total_playlists
    `);
    console.log('\nFinal counts:');
    console.table(totals.rows);

    console.log('\n✅ Done. If counts look correct, run: scripts/cleanup_json_columns.sql\n');

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n❌ Script failed:', err);
  process.exit(1);
});
