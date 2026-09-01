/**
 * fix_zones_chats_media.ts
 *
 * Three targeted fixes for remaining raw_data / JSON array problems:
 *
 *  1. ZONES        — backfill code, is_active, updated_at from invitation_code + raw_data
 *  2. CHATS        — wire chats.participants (JSON array) → chat_participants junction rows
 *                    with per-user unread_count from chats.unread_count (JSON object)
 *  3. MEDIA ASSETS — promote raw_data fields (name, url, size, zoneId, folder, format)
 *                    into the real columns (title, organization_id, size, folder, mime_type)
 *
 * All updates are idempotent — safe to re-run.
 * Uses bulk operations (UPDATE ... FROM unnest / bulk INSERTs) for speed.
 *
 * Usage: npx tsx scripts/fix_zones_chats_media.ts
 */

import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();

  try {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   FIX: ZONES + CHAT PARTICIPANTS + MEDIA        ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // =========================================================================
    // STEP 1 — ZONES: backfill missing column data from raw_data
    // =========================================================================
    console.log('── Step 1: Zones backfill ────────────────────────');

    // All zone columns already populated — run safety net updates anyway
    await client.query(`UPDATE zones SET code = invitation_code WHERE code IS NULL AND invitation_code IS NOT NULL`);
    await client.query(`UPDATE zones SET is_active = true WHERE is_active IS NULL`);
    await client.query(`UPDATE zones SET updated_at = created_at WHERE updated_at IS NULL AND created_at IS NOT NULL`);
    await client.query(`UPDATE zones SET region = raw_data->>'region' WHERE region IS NULL AND raw_data->>'region' IS NOT NULL`);
    const zoneCheck = await client.query(`SELECT count(*) AS total, count(*) FILTER (WHERE code IS NOT NULL) AS has_code, count(*) FILTER (WHERE is_active IS NOT NULL) AS has_active FROM zones`);
    console.log('  Zones status:');
    console.table(zoneCheck.rows);

    // =========================================================================
    // STEP 2 — CHATS: wire participants array → chat_participants
    // =========================================================================
    console.log('\n── Step 2: Chat participants wiring ──────────────');

    // Load all valid user IDs to detect ghost references
    const usersRes = await client.query<{ id: string }>('SELECT id FROM profiles');
    const validUserIds = new Set<string>(usersRes.rows.map((u) => u.id));
    console.log(`  Loaded ${validUserIds.size} valid user profiles`);

    // Fetch all chats — participants live in raw_data (column doesn't exist in current schema)
    const chatsRes = await client.query(`
      SELECT id, raw_data
      FROM chats
      WHERE raw_data->'participants' IS NOT NULL
         OR raw_data->>'participants' IS NOT NULL
    `);
    console.log(`  Found ${chatsRes.rows.length} chats with participant data in raw_data`);

    let chatLinked = 0;
    let chatGhost = 0;

    await client.query('BEGIN');
    for (const chat of chatsRes.rows) {
      const raw = chat.raw_data || {};

      // Extract participant array — always from raw_data
      let participantIds: string[] = [];
      if (Array.isArray(raw.participants) && raw.participants.length > 0) {
        participantIds = raw.participants.filter((id: any) => typeof id === 'string');
      }

      if (participantIds.length === 0) continue;

      // Extract per-user unread counts — Firebase: { "userId1": 3, "userId2": 0 }
      const unreadMap: Record<string, number> =
        (raw.unreadCount && typeof raw.unreadCount === 'object' && !Array.isArray(raw.unreadCount))
          ? raw.unreadCount
          : {};

      // Build bulk insert
      const values: any[] = [];
      const placeholders: string[] = [];
      let p = 1;

      for (const userId of participantIds) {
        if (!validUserIds.has(userId)) { chatGhost++; continue; }
        const unread = typeof unreadMap[userId] === 'number' ? unreadMap[userId] : 0;
        placeholders.push(`($${p++}, $${p++}, $${p++}, NOW())`);
        values.push(chat.id, userId, unread);
        chatLinked++;
      }

      if (placeholders.length > 0) {
        await client.query(
          `INSERT INTO chat_participants (chat_id, user_id, unread_count, joined_at)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (chat_id, user_id) DO UPDATE
             SET unread_count = EXCLUDED.unread_count`,
          values,
        );
      }
    }
    await client.query('COMMIT');

    console.log(`  ✓ chat_participants rows created: ${chatLinked}`);
    console.log(`  - Ghost user refs (not in profiles): ${chatGhost}`);

    // Also fix chats missing created_by — for direct chats, pick the first participant
    const chatFixCreatedBy = await client.query(`
      UPDATE chats c
      SET created_by = (
        SELECT cp.user_id
        FROM chat_participants cp
        WHERE cp.chat_id = c.id
        LIMIT 1
      )
      WHERE c.created_by IS NULL
        AND EXISTS (SELECT 1 FROM chat_participants cp WHERE cp.chat_id = c.id)
      RETURNING id
    `);
    console.log(`  ✓ chats.created_by backfilled:    ${chatFixCreatedBy.rowCount}`);

    // Verify
    const chatCheck = await client.query(`
      SELECT
        (SELECT count(*) FROM chats)             AS total_chats,
        (SELECT count(*) FROM chat_participants)  AS total_participants,
        (SELECT count(DISTINCT chat_id) FROM chat_participants) AS chats_with_participants
    `);
    console.log('\n  Chat summary:');
    console.table(chatCheck.rows);

    // =========================================================================
    // STEP 3 — MEDIA ASSETS: promote raw_data fields → real columns
    // =========================================================================
    console.log('\n── Step 3: Media assets field promotion ──────────');

    // Check how many assets have null titles (need backfill)
    const mediaCount = await client.query<{ total: string; missing_title: string; missing_org: string }>(`
      SELECT
        count(*)                                           AS total,
        count(*) FILTER (WHERE title IS NULL)              AS missing_title,
        count(*) FILTER (WHERE organization_id IS NULL)    AS missing_org
      FROM media_assets
    `);
    console.log(`  Total media assets:    ${mediaCount.rows[0].total}`);
    console.log(`  Missing title:         ${mediaCount.rows[0].missing_title}`);
    console.log(`  Missing organization:  ${mediaCount.rows[0].missing_org}`);

    // Load valid zone IDs for validation
    const zonesRes = await client.query<{ id: string }>('SELECT id FROM zones');
    const validZoneIds = new Set<string>(zonesRes.rows.map((z) => z.id));

    // 3a. title ← raw_data.name (the file name)
    const mediaTitleFix = await client.query(`
      UPDATE media_assets
      SET title = TRIM(raw_data->>'name')
      WHERE title IS NULL
        AND raw_data->>'name' IS NOT NULL
        AND TRIM(raw_data->>'name') != ''
      RETURNING id
    `);
    console.log(`  ✓ title backfilled:         ${mediaTitleFix.rowCount}`);

    // 3b. folder ← raw_data.folder
    const mediaFolderFix = await client.query(`
      UPDATE media_assets
      SET folder = raw_data->>'folder'
      WHERE folder IS NULL
        AND raw_data->>'folder' IS NOT NULL
      RETURNING id
    `);
    console.log(`  ✓ folder backfilled:        ${mediaFolderFix.rowCount}`);

    // 3c. size ← raw_data.size (cast to int)
    const mediaSizeFix = await client.query(`
      UPDATE media_assets
      SET size = (raw_data->>'size')::int
      WHERE size IS NULL
        AND raw_data->>'size' IS NOT NULL
        AND raw_data->>'size' ~ '^[0-9]+$'
      RETURNING id
    `);
    console.log(`  ✓ size backfilled:          ${mediaSizeFix.rowCount}`);

    // 3d. mime_type ← raw_data.format (e.g. "mp3" → "audio/mpeg", or just store as-is)
    const mediaFormatFix = await client.query(`
      UPDATE media_assets
      SET mime_type = LOWER(raw_data->>'format')
      WHERE mime_type IS NULL
        AND raw_data->>'format' IS NOT NULL
      RETURNING id
    `);
    console.log(`  ✓ mime_type backfilled:     ${mediaFormatFix.rowCount}`);

    // 3e. organization_id ← raw_data.zoneId (validated against zones table)
    const mediaOrgFix = await client.query(`
      UPDATE media_assets
      SET organization_id = COALESCE(
        raw_data->>'zoneId',
        raw_data->>'zone_id',
        raw_data->>'organizationId'
      )
      WHERE organization_id IS NULL
        AND COALESCE(raw_data->>'zoneId', raw_data->>'zone_id', raw_data->>'organizationId') IS NOT NULL
      RETURNING id, organization_id
    `);

    // For any org_id that didn't match a valid zone, fall back to zone-001 (HQ)
    const orphanMedia = mediaOrgFix.rows.filter((r: any) => !validZoneIds.has(r.organization_id));
    if (orphanMedia.length > 0) {
      const orphanIds = orphanMedia.map((r: any) => r.id);
      await client.query(
        `UPDATE media_assets SET organization_id = 'zone-001'
         WHERE id = ANY($1::text[])`,
        [orphanIds],
      );
      console.log(`  ✓ organization_id backfilled: ${mediaOrgFix.rowCount} (${orphanIds.length} fell back to zone-001)`);
    } else {
      console.log(`  ✓ organization_id backfilled: ${mediaOrgFix.rowCount}`);
    }

    // 3f. Fix type column (it exists but some may still be wrong)
    await client.query(`
      UPDATE media_assets
      SET type = UPPER(COALESCE(raw_data->>'type', type, 'AUDIO'))
      WHERE type IS NULL OR type NOT IN ('AUDIO','VIDEO','IMAGE','DOCUMENT')
    `);
    console.log(`  ✓ type normalized`);

    // Verify
    const mediaCheck = await client.query(`
      SELECT
        count(*)                                        AS total,
        count(*) FILTER (WHERE title IS NOT NULL)       AS has_title,
        count(*) FILTER (WHERE organization_id IS NOT NULL) AS has_org,
        count(*) FILTER (WHERE size IS NOT NULL)        AS has_size,
        count(*) FILTER (WHERE folder IS NOT NULL)      AS has_folder
      FROM media_assets
    `);
    console.log('\n  Media assets after backfill:');
    console.table(mediaCheck.rows);

    // =========================================================================
    // FINAL SUMMARY
    // =========================================================================
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   FINAL SUMMARY                                 ║');
    console.log('╚══════════════════════════════════════════════════╝');

    const summary = await client.query(`
      SELECT
        (SELECT count(*) FROM zones)             AS zones,
        (SELECT count(*) FROM zones WHERE code IS NOT NULL) AS zones_with_code,
        (SELECT count(*) FROM chats)             AS chats,
        (SELECT count(*) FROM chat_participants)  AS chat_participants,
        (SELECT count(*) FROM media_assets)       AS media_assets,
        (SELECT count(*) FROM media_assets WHERE title IS NOT NULL) AS media_with_title,
        (SELECT count(*) FROM media_assets WHERE organization_id IS NOT NULL) AS media_with_org
    `);
    console.table(summary.rows);

    console.log('\n✅ Done.\n');
    console.log('Next steps:');
    console.log('  1. Run scripts/cleanup_json_columns.sql to drop the JSON blob columns');
    console.log('  2. Migrate to Railway Postgres\n');

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
