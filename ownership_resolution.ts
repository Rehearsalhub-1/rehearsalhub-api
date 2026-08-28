/**
 * RehearsalHub — Ownership Resolution Deep-Dive
 * READ-ONLY. Makes ZERO writes, deletes, renames or schema changes.
 *
 * Run: npx tsx ownership_resolution.ts
 */

import pg from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

const directUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString: directUrl, ssl: { rejectUnauthorized: false } });

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

// ─────────────────────────────────────────────────────────────────────────────
// HQ_GROUP_IDS extracted directly from praise-nights.routes.ts line 23-27
// ─────────────────────────────────────────────────────────────────────────────
const HQ_GROUP_IDS_FROM_CODE = new Set([
  'zone-001', 'zone-002', 'zone-003', 'zone-004', 'zone-005',
  'loveworld-singers-hq', 'zone001', 'zone002', 'zone003', 'zone004', 'zone005',
  'hq',
]);

function hr(label: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('═'.repeat(60));
}

async function main() {
  hr('RehearsalHub — Ownership Resolution Report (READ-ONLY)');
  console.log(`  Started: ${new Date().toISOString()}\n`);

  const report: Record<string, any> = {
    generatedAt: new Date().toISOString(),
    sections: {},
  };

  // ═══════════════════════════════════════════════════════════════
  // SECTION 1: HQ ZONE IDENTITY
  // What is zone-001? What is zone-002?
  // Do they share song ownership? Do users span both?
  // ═══════════════════════════════════════════════════════════════
  hr('SECTION 1 — HQ Zone Identity');

  // Full zone list with all columns
  const allZones = await q(`SELECT * FROM zones ORDER BY id`);
  console.log('\n1a. All zones (full row data):');
  allZones.forEach((z: any) => {
    const rawKeys = z.raw_data ? Object.keys(z.raw_data) : [];
    console.log(`   ${z.id.padEnd(25)} name="${z.name}" is_hq=${z.is_hq} is_active=${z.is_active} rawKeys=[${rawKeys.join(',')}]`);
  });

  // HQ_GROUP_IDS from code — which ones actually exist in DB?
  console.log('\n1b. HQ_GROUP_IDS from route code vs actual DB zones:');
  const hqCodeIds = [...HQ_GROUP_IDS_FROM_CODE];
  for (const hqId of hqCodeIds) {
    const row = allZones.find((z: any) => z.id === hqId);
    console.log(`   ${hqId.padEnd(30)} ${row ? `EXISTS: "${row.name}"` : '⚠ NOT IN DB'}`);
  }

  // Song ownership by zone — is 'hq' scope tied to zone-001 or zone-002?
  console.log('\n1c. Songs by zone_id (top 10 zones by count, including NULL):');
  const songsByZone = await q(`
    SELECT zone_id, scope, COUNT(*) AS n
    FROM songs
    GROUP BY zone_id, scope
    ORDER BY n DESC
    LIMIT 20
  `);
  songsByZone.forEach((r: any) =>
    console.log(`   zone_id=${String(r.zone_id ?? 'NULL').padEnd(20)} scope=${String(r.scope ?? 'NULL').padEnd(12)} songs=${r.n}`)
  );

  // Profile distribution across zone-001 and zone-002
  console.log('\n1d. Profile (user) counts by zone_id:');
  const profilesByZone = await q(`
    SELECT zone_id, role, COUNT(*) AS n
    FROM profiles
    GROUP BY zone_id, role
    ORDER BY n DESC
    LIMIT 20
  `);
  profilesByZone.forEach((r: any) =>
    console.log(`   zone_id=${String(r.zone_id ?? 'NULL').padEnd(20)} role=${String(r.role ?? 'NULL').padEnd(20)} users=${r.n}`)
  );

  // Programs distribution
  console.log('\n1e. Program counts by zone_id + scope:');
  const programsByZone = await q(`
    SELECT zone_id, scope, COUNT(*) AS n
    FROM programs
    GROUP BY zone_id, scope
    ORDER BY n DESC
  `);
  programsByZone.forEach((r: any) =>
    console.log(`   zone_id=${String(r.zone_id ?? 'NULL').padEnd(20)} scope=${String(r.scope ?? 'NULL').padEnd(12)} programs=${r.n}`)
  );

  // Are zone-001 and zone-002 truly separate tenants, or do they share data?
  console.log('\n1f. Do zone-001 and zone-002 share songs (same song_id in both)?');
  const sharedSongs = await q(`
    SELECT COUNT(*) AS n FROM songs
    WHERE zone_id IN ('zone-001', 'zone-002')
  `);
  const zone001Songs = await q(`SELECT COUNT(*) AS n FROM songs WHERE zone_id = 'zone-001'`);
  const zone002Songs = await q(`SELECT COUNT(*) AS n FROM songs WHERE zone_id = 'zone-002'`);
  console.log(`   Songs owned by zone-001: ${zone001Songs[0].n}`);
  console.log(`   Songs owned by zone-002: ${zone002Songs[0].n}`);
  console.log(`   Songs with zone_id IN (zone-001, zone-002): ${sharedSongs[0].n}`);

  // What does rawData say about zone-001 vs zone-002?
  console.log('\n1g. zone-001 rawData:');
  const zone001 = allZones.find((z: any) => z.id === 'zone-001');
  console.log('  ', JSON.stringify(zone001?.raw_data ?? {}, null, 2).slice(0, 600));
  console.log('\n1h. zone-002 rawData:');
  const zone002 = allZones.find((z: any) => z.id === 'zone-002');
  console.log('  ', JSON.stringify(zone002?.raw_data ?? {}, null, 2).slice(0, 600));

  report.sections.hqIdentity = {
    allZones,
    hqCodeIdsInDb: hqCodeIds.filter(id => allZones.find((z: any) => z.id === id)),
    hqCodeIdsNotInDb: hqCodeIds.filter(id => !allZones.find((z: any) => z.id === id)),
    songsByZone,
    profilesByZone,
    programsByZone,
    zone001Songs: zone001Songs[0].n,
    zone002Songs: zone002Songs[0].n,
  };

  // ═══════════════════════════════════════════════════════════════
  // SECTION 2: MEDIA ASSETS — Classify the 7,651 with NULL zone_id
  // ═══════════════════════════════════════════════════════════════
  hr('SECTION 2 — Media Assets NULL zone_id Classification');

  // What columns does media_assets have?
  const mediaColumns = await q(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media_assets'
    ORDER BY ordinal_position
  `);
  console.log('\n2a. media_assets columns:');
  mediaColumns.forEach((c: any) =>
    console.log(`   ${c.column_name.padEnd(25)} ${c.data_type} nullable=${c.is_nullable}`)
  );

  // Sample null-zone media assets — what raw_data do they contain?
  console.log('\n2b. Sample of media_assets with NULL zone_id (20 rows):');
  const nullZoneMedia = await q(`
    SELECT id, zone_id, raw_data
    FROM media_assets
    WHERE zone_id IS NULL
    LIMIT 20
  `);
  nullZoneMedia.forEach((m: any) => {
    const raw = m.raw_data || {};
    const interesting = {
      id: m.id,
      zone_id_in_raw: raw.zoneId || raw.zone_id || raw.zone || '(none)',
      owner_in_raw: raw.ownerId || raw.owner_id || raw.uploadedBy || raw.userId || '(none)',
      type_in_raw: raw.type || raw.mediaType || '(none)',
      folder_in_raw: raw.folder || raw.path || raw.directory || '(none)',
      name_in_raw: raw.name || raw.title || raw.fileName || '(none)',
      scope_in_raw: raw.scope || '(none)',
    };
    console.log(`   ${JSON.stringify(interesting)}`);
  });

  // Classify by scope field inside rawData
  console.log('\n2c. Distribution of raw_data.scope for null-zone media assets:');
  const mediaScopeDist = await q(`
    SELECT
      COALESCE(raw_data->>'scope', '(null)') AS scope_val,
      COUNT(*) AS n
    FROM media_assets
    WHERE zone_id IS NULL
    GROUP BY scope_val
    ORDER BY n DESC
  `);
  mediaScopeDist.forEach((r: any) => console.log(`   scope=${r.scope_val.padEnd(20)} count=${r.n}`));

  // Classify by type inside rawData
  console.log('\n2d. Distribution of raw_data.type for null-zone media assets:');
  const mediaTypeDist = await q(`
    SELECT
      COALESCE(raw_data->>'type', COALESCE(raw_data->>'mediaType', '(null)')) AS type_val,
      COUNT(*) AS n
    FROM media_assets
    WHERE zone_id IS NULL
    GROUP BY type_val
    ORDER BY n DESC
    LIMIT 20
  `);
  mediaTypeDist.forEach((r: any) => console.log(`   type=${r.type_val.padEnd(25)} count=${r.n}`));

  // Classify by zoneId inside rawData
  console.log('\n2e. Distribution of raw_data.zoneId for null-zone media assets:');
  const mediaRawZoneDist = await q(`
    SELECT
      COALESCE(raw_data->>'zoneId', COALESCE(raw_data->>'zone_id', '(null)')) AS raw_zone_val,
      COUNT(*) AS n
    FROM media_assets
    WHERE zone_id IS NULL
    GROUP BY raw_zone_val
    ORDER BY n DESC
    LIMIT 20
  `);
  mediaRawZoneDist.forEach((r: any) => console.log(`   raw_zone=${r.raw_zone_val.padEnd(25)} count=${r.n}`));

  // How many null-zone media assets have a zoneId INSIDE rawData?
  const mediaWithRawZone = await q(`
    SELECT COUNT(*) AS n FROM media_assets
    WHERE zone_id IS NULL
      AND (raw_data->>'zoneId' IS NOT NULL OR raw_data->>'zone_id' IS NOT NULL)
  `);
  const mediaWithRawOwner = await q(`
    SELECT COUNT(*) AS n FROM media_assets
    WHERE zone_id IS NULL
      AND (raw_data->>'ownerId' IS NOT NULL OR raw_data->>'uploadedBy' IS NOT NULL OR raw_data->>'userId' IS NOT NULL)
  `);
  const mediaWithNoRawZoneNoOwner = await q(`
    SELECT COUNT(*) AS n FROM media_assets
    WHERE zone_id IS NULL
      AND raw_data->>'zoneId' IS NULL
      AND raw_data->>'zone_id' IS NULL
      AND raw_data->>'ownerId' IS NULL
      AND raw_data->>'uploadedBy' IS NULL
  `);
  console.log(`\n   null-zone media WITH zoneId in rawData:    ${mediaWithRawZone[0].n}`);
  console.log(`   null-zone media WITH ownerId in rawData:   ${mediaWithRawOwner[0].n}`);
  console.log(`   null-zone media WITH NEITHER (truly orphan): ${mediaWithNoRawZoneNoOwner[0].n}`);

  // The 5 with orphan zone_ids (zone_id set but points to non-existent zone)
  console.log('\n2f. Media assets with ORPHAN zone_id (zone_id set but zone doesn\'t exist):');
  const orphanZoneMedia = await q(`
    SELECT m.id, m.zone_id, m.raw_data
    FROM media_assets m
    LEFT JOIN zones z ON z.id = m.zone_id
    WHERE m.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanZoneMedia.forEach((m: any) =>
    console.log(`   id=${m.id} zone_id=${m.zone_id} raw_zone=${m.raw_data?.zoneId ?? '(none)'}`)
  );

  report.sections.mediaAssets = {
    columns: mediaColumns,
    nullZoneSampleData: nullZoneMedia,
    scopeDistribution: mediaScopeDist,
    typeDistribution: mediaTypeDist,
    rawZoneDistribution: mediaRawZoneDist,
    withRawZoneId: mediaWithRawZone[0].n,
    withRawOwnerId: mediaWithRawOwner[0].n,
    trulyOrphan: mediaWithNoRawZoneNoOwner[0].n,
    orphanZoneIds: orphanZoneMedia,
  };

  // ═══════════════════════════════════════════════════════════════
  // SECTION 3: PROFILES with no zone and no subgroup
  // ═══════════════════════════════════════════════════════════════
  hr('SECTION 3 — Unassigned Profiles (no zone_id, no subgroup_id)');

  const unassignedProfiles = await q(`
    SELECT
      p.id, p.email, p.name, p.first_name, p.last_name,
      p.role, p.voice_part, p.zone_id, p.subgroup_id,
      p.profile_completed, p.created_at,
      p.raw_data->>'kingschatId' AS kingschat_id,
      p.raw_data->>'status' AS raw_status
    FROM profiles p
    WHERE p.zone_id IS NULL AND p.subgroup_id IS NULL
    ORDER BY p.created_at DESC NULLS LAST
  `);
  console.log(`\n  Total unassigned profiles: ${unassignedProfiles.length}`);
  unassignedProfiles.forEach((p: any) => {
    console.log(`\n  ID: ${p.id}`);
    console.log(`    email:     ${p.email ?? '(none)'}`);
    console.log(`    name:      ${p.name ?? ''} ${p.first_name ?? ''} ${p.last_name ?? ''}`);
    console.log(`    role:      ${p.role ?? '(none)'}`);
    console.log(`    voice:     ${p.voice_part ?? '(none)'}`);
    console.log(`    completed: ${p.profile_completed}`);
    console.log(`    created:   ${p.created_at}`);
    console.log(`    kc_id:     ${p.kingschat_id ?? '(none)'}`);
    console.log(`    status:    ${p.raw_status ?? '(none)'}`);
  });
  report.sections.unassignedProfiles = unassignedProfiles;

  // ═══════════════════════════════════════════════════════════════
  // SECTION 4: ALL ORPHAN RECORDS — full enumeration
  // ═══════════════════════════════════════════════════════════════
  hr('SECTION 4 — Complete Orphan Record Enumeration');

  // 4a. Songs with orphan zone_id (2 records)
  console.log('\n4a. Songs with orphan zone_id (zone_id set, no matching zone):');
  const orphanSongs = await q(`
    SELECT s.id, s.title, s.zone_id, s.scope, s.organization_id,
           s.raw_data->>'zoneId' AS raw_zone
    FROM songs s
    LEFT JOIN zones z ON z.id = s.zone_id
    WHERE s.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanSongs.forEach((s: any) => console.log(`   ${JSON.stringify(s)}`));
  report.sections.orphans = { songs: orphanSongs };

  // 4b. Songs with orphan praise_night_id (20 records)
  console.log('\n4b. Songs with orphan praise_night_id (no matching program):');
  const orphanPraiseNight = await q(`
    SELECT s.id, s.title, s.praise_night_id,
           s.zone_id, s.scope
    FROM songs s
    LEFT JOIN programs p ON p.id = s.praise_night_id
    WHERE s.praise_night_id IS NOT NULL AND p.id IS NULL
  `);
  orphanPraiseNight.forEach((s: any) => console.log(`   ${JSON.stringify(s)}`));
  report.sections.orphans.praiseNightIds = orphanPraiseNight;

  // 4c. Submitted songs with orphan zone_id (5 records)
  console.log('\n4c. Submitted songs with orphan zone_id:');
  const orphanSubmitted = await q(`
    SELECT ss.id, ss.zone_id, ss.status,
           ss.raw_data->>'title' AS title,
           ss.raw_data->>'zoneId' AS raw_zone
    FROM submitted_songs ss
    LEFT JOIN zones z ON z.id = ss.zone_id
    WHERE ss.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanSubmitted.forEach((s: any) => console.log(`   ${JSON.stringify(s)}`));
  report.sections.orphans.submittedSongs = orphanSubmitted;

  // 4d. Notification with orphan zone_id (1 record)
  console.log('\n4d. Notifications with orphan zone_id:');
  const orphanNotifs = await q(`
    SELECT n.id, n.zone_id, n.type, n.title,
           n.raw_data->>'zoneId' AS raw_zone
    FROM notifications n
    LEFT JOIN zones z ON z.id = n.zone_id
    WHERE n.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanNotifs.forEach((n: any) => console.log(`   ${JSON.stringify(n)}`));
  report.sections.orphans.notifications = orphanNotifs;

  // 4e. Attendance with orphan user_id (10 records)
  console.log('\n4e. Attendance records with orphan user_id:');
  const orphanAtt = await q(`
    SELECT a.id, a.user_id, a.rehearsal_id, a.zone_id, a.status, a.created_at
    FROM attendance a
    LEFT JOIN profiles p ON p.id = a.user_id
    WHERE a.user_id IS NOT NULL AND p.id IS NULL
  `);
  orphanAtt.forEach((a: any) => console.log(`   ${JSON.stringify(a)}`));
  report.sections.orphans.attendance = orphanAtt;

  // 4f. Attendance with orphan zone_id (5 records)
  console.log('\n4f. Attendance records with orphan zone_id:');
  const orphanAttZone = await q(`
    SELECT a.id, a.user_id, a.zone_id, a.status
    FROM attendance a
    LEFT JOIN zones z ON z.id = a.zone_id
    WHERE a.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanAttZone.forEach((a: any) => console.log(`   ${JSON.stringify(a)}`));
  report.sections.orphans.attendanceZone = orphanAttZone;

  // ═══════════════════════════════════════════════════════════════
  // SECTION 5: EXACT JOIN TABLE ROW ESTIMATES
  // Count the actual items in the JSON arrays before migration
  // ═══════════════════════════════════════════════════════════════
  hr('SECTION 5 — Exact Join Table Row Counts (from JSON arrays)');

  // 5a. program_songs — from programs.song_ids
  console.log('\n5a. program_songs estimate (from programs.song_ids):');
  const programSongCount = await q(`
    SELECT COUNT(*) AS total_items FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(song_ids::jsonb) = 'array' THEN song_ids::jsonb ELSE '[]'::jsonb END
      ) AS song_id
      FROM programs
      WHERE song_ids IS NOT NULL
    ) sub
    WHERE song_id IS NOT NULL AND song_id != ''
  `);
  const programSongCountValid = await q(`
    SELECT COUNT(*) AS valid_items FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(song_ids::jsonb) = 'array' THEN song_ids::jsonb ELSE '[]'::jsonb END
      ) AS sid
      FROM programs WHERE song_ids IS NOT NULL
    ) sub
    WHERE sid IS NOT NULL AND sid != ''
      AND EXISTS (SELECT 1 FROM songs WHERE id = sub.sid)
  `);
  const programsWithSongIds = await q(`
    SELECT COUNT(*) AS n FROM programs
    WHERE jsonb_typeof(song_ids::jsonb) = 'array'
      AND jsonb_array_length(song_ids::jsonb) > 0
  `);
  const programsWithSongsJson = await q(`
    SELECT COUNT(*) AS n FROM programs
    WHERE jsonb_typeof(songs::jsonb) = 'array'
      AND jsonb_array_length(songs::jsonb) > 0
  `);
  console.log(`   Programs with non-empty song_ids:  ${programsWithSongIds[0].n}`);
  console.log(`   Programs with non-empty songs:     ${programsWithSongsJson[0].n}`);
  console.log(`   Total song_id entries in arrays:   ${programSongCount[0].total_items}`);
  console.log(`   Valid entries (song exists in DB): ${programSongCountValid[0].valid_items}`);
  console.log(`   → program_songs rows to insert:    ${programSongCountValid[0].valid_items}`);

  // Per-program breakdown (top 10)
  console.log('\n   Programs with most songs (top 10):');
  const perProgramSongs = await q(`
    SELECT p.id, p.name,
      jsonb_array_length(CASE WHEN jsonb_typeof(p.song_ids::jsonb) = 'array' THEN p.song_ids::jsonb ELSE '[]'::jsonb END) AS song_count
    FROM programs p
    WHERE song_ids IS NOT NULL
    ORDER BY song_count DESC
    LIMIT 10
  `);
  perProgramSongs.forEach((p: any) =>
    console.log(`   "${String(p.name ?? '').slice(0,40).padEnd(42)}" → ${p.song_count} songs`)
  );

  // 5b. playlist_items — from playlists.song_ids
  console.log('\n5b. playlist_items estimate (from playlists.song_ids):');
  const playlistItemCount = await q(`
    SELECT COUNT(*) AS total_items FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(song_ids::jsonb) = 'array' THEN song_ids::jsonb ELSE '[]'::jsonb END
      ) AS song_id
      FROM playlists WHERE song_ids IS NOT NULL
    ) sub WHERE song_id IS NOT NULL AND song_id != ''
  `);
  const playlistItemCountValid = await q(`
    SELECT COUNT(*) AS valid_items FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(song_ids::jsonb) = 'array' THEN song_ids::jsonb ELSE '[]'::jsonb END
      ) AS sid
      FROM playlists WHERE song_ids IS NOT NULL
    ) sub
    WHERE sid IS NOT NULL AND sid != ''
      AND EXISTS (SELECT 1 FROM songs WHERE id = sub.sid)
  `);
  const playlistsWithSongIds = await q(`
    SELECT COUNT(*) AS n FROM playlists
    WHERE jsonb_typeof(song_ids::jsonb) = 'array'
      AND jsonb_array_length(song_ids::jsonb) > 0
  `);
  console.log(`   Playlists with non-empty song_ids: ${playlistsWithSongIds[0].n}`);
  console.log(`   Total song_id entries in arrays:   ${playlistItemCount[0].total_items}`);
  console.log(`   Valid entries (song exists in DB): ${playlistItemCountValid[0].valid_items}`);
  console.log(`   → playlist_items rows to insert:   ${playlistItemCountValid[0].valid_items}`);

  // 5c. chat_participants — from chats.participants
  console.log('\n5c. chat_participants estimate (from chats.participants):');
  const chatParticipantCount = await q(`
    SELECT COUNT(*) AS total_items FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(participants::jsonb) = 'array' THEN participants::jsonb ELSE '[]'::jsonb END
      ) AS user_id
      FROM chats WHERE participants IS NOT NULL
    ) sub WHERE user_id IS NOT NULL AND user_id != ''
  `);
  const chatParticipantCountValid = await q(`
    SELECT COUNT(*) AS valid_items FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(participants::jsonb) = 'array' THEN participants::jsonb ELSE '[]'::jsonb END
      ) AS uid
      FROM chats WHERE participants IS NOT NULL
    ) sub
    WHERE uid IS NOT NULL AND uid != ''
      AND EXISTS (SELECT 1 FROM profiles WHERE id = sub.uid)
  `);
  const chatsWithParticipants = await q(`
    SELECT COUNT(*) AS n FROM chats
    WHERE jsonb_typeof(participants::jsonb) = 'array'
      AND jsonb_array_length(participants::jsonb) > 0
  `);
  // Average and max participants
  const participantStats = await q(`
    SELECT
      AVG(jsonb_array_length(participants::jsonb)) AS avg_p,
      MAX(jsonb_array_length(participants::jsonb)) AS max_p,
      MIN(jsonb_array_length(participants::jsonb)) AS min_p
    FROM chats
    WHERE jsonb_typeof(participants::jsonb) = 'array'
  `);
  console.log(`   Chats with participants array:     ${chatsWithParticipants[0].n}`);
  console.log(`   Total participant entries:         ${chatParticipantCount[0].total_items}`);
  console.log(`   Valid (user exists in DB):         ${chatParticipantCountValid[0].valid_items}`);
  console.log(`   Avg participants per chat:         ${Number(participantStats[0]?.avg_p || 0).toFixed(1)}`);
  console.log(`   Max participants in one chat:      ${participantStats[0]?.max_p}`);
  console.log(`   → chat_participants rows to insert: ${chatParticipantCountValid[0].valid_items}`);

  // 5d. memberships estimate
  console.log('\n5d. memberships estimate (from profiles):');
  const profileWithZone = await q(`SELECT COUNT(*) AS n FROM profiles WHERE zone_id IS NOT NULL`);
  const profileNoZone = await q(`SELECT COUNT(*) AS n FROM profiles WHERE zone_id IS NULL`);
  console.log(`   Profiles with zone_id (clear membership): ${profileWithZone[0].n}`);
  console.log(`   Profiles without zone_id (ambiguous):     ${profileNoZone[0].n}`);
  console.log(`   → Safe membership rows to create:         ${profileWithZone[0].n}`);
  console.log(`   → Rows needing manual zone assignment:     ${profileNoZone[0].n}`);

  report.sections.joinTableEstimates = {
    programSongs: {
      programsWithSongIds: programsWithSongIds[0].n,
      totalEntries: programSongCount[0].total_items,
      validEntries: programSongCountValid[0].valid_items,
      topPrograms: perProgramSongs,
    },
    playlistItems: {
      playlistsWithSongIds: playlistsWithSongIds[0].n,
      totalEntries: playlistItemCount[0].total_items,
      validEntries: playlistItemCountValid[0].valid_items,
    },
    chatParticipants: {
      chatsWithParticipants: chatsWithParticipants[0].n,
      totalEntries: chatParticipantCount[0].total_items,
      validEntries: chatParticipantCountValid[0].valid_items,
      stats: participantStats[0],
    },
    memberships: {
      safeToCreate: profileWithZone[0].n,
      needsReview: profileNoZone[0].n,
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // SECTION 6: CODE DEPENDENCY ANALYSIS
  // Which routes read/write each legacy field?
  // ═══════════════════════════════════════════════════════════════
  hr('SECTION 6 — Legacy Field Code Dependencies (from grep scan)');

  // Already run via shell — summarize findings
  const legacyFieldDependencies = {
    scope: [
      'categories.routes.ts', 'masterSongs.ts', 'media.routes.ts',
      'notifications.routes.ts', 'praise-nights.routes.ts', 'profiles.routes.ts',
      'songs.routes.ts', 'subgroups.routes.ts', 'submitted-songs.routes.ts',
      'upcomingEvents.routes.ts',
    ],
    zone_id_or_zoneId: [
      'categories.routes.ts', 'media.routes.ts', 'notifications.routes.ts',
      'praise-nights.routes.ts', 'profiles.routes.ts', 'songs.routes.ts',
      'subgroups.routes.ts', 'submitted-songs.routes.ts', 'upcomingEvents.routes.ts',
      'attendance.routes.ts', 'chats.routes.ts', 'internal-cron.routes.ts',
      'members.routes.ts', 'support.routes.ts', 'writes.routes.ts',
      'activity-logs.routes.ts', 'praiseNightSongs.ts', 'schedule.routes.ts',
      'subscriptions.routes.ts', 'zones.routes.ts',
    ],
    song_ids_or_songIds: [
      'praise-nights.routes.ts', 'songs.routes.ts', 'subgroups.routes.ts',
      'favorites.routes.ts', 'playlists.routes.ts',
    ],
    praise_night_id_or_praiseNightId: [
      'praise-nights.routes.ts', 'songs.routes.ts',
      'subgroups.routes.ts', 'praiseNightSongs.ts',
    ],
    participants: [
      'chats.routes.ts', 'support.routes.ts', 'writes.routes.ts',
      'calls.routes.ts', 'livekit.routes.ts',
    ],
    songs_dot_notation: [
      'praise-nights.routes.ts', 'songs.routes.ts', 'favorites.routes.ts', 'playlists.routes.ts',
    ],
  };

  console.log('\n  Routes that MUST be updated after each backfill phase:\n');
  console.log('  PHASE A — After memberships backfill:');
  console.log('    members.routes.ts, profiles.routes.ts, zones.routes.ts');
  console.log('    (these use zone_id/role to determine access — switch to membership table)');

  console.log('\n  PHASE B — After program_songs backfill:');
  console.log('    praise-nights.routes.ts, songs.routes.ts, subgroups.routes.ts');
  console.log('    praiseNightSongs.ts — reads/writes praise_night_id and song_ids');

  console.log('\n  PHASE C — After playlist_items backfill:');
  console.log('    playlists.routes.ts, favorites.routes.ts');
  console.log('    (currently iterate songs/songIds JSON arrays)');

  console.log('\n  PHASE D — After chat_participants backfill:');
  console.log('    chats.routes.ts, writes.routes.ts, calls.routes.ts, livekit.routes.ts');
  console.log('    support.routes.ts (uses participants JSON)');

  console.log('\n  PHASE E — After notifications backfill:');
  console.log('    notifications.routes.ts');

  console.log('\n  PHASE F — scope field removal (last, after all above are done):');
  console.log('    ALL 10 routes that use scope= still need to be migrated to organizationId queries');

  report.sections.codeDependencies = legacyFieldDependencies;

  // ═══════════════════════════════════════════════════════════════
  // SECTION 7: ADDITIONAL CROSS-CHECKS
  // ═══════════════════════════════════════════════════════════════
  hr('SECTION 7 — Additional Cross-Checks');

  // Do any songs reference zone-003, zone-004, zone-005 (in HQ_GROUP_IDS from code but not in DB)?
  console.log('\n7a. Song zone_ids that appear in HQ_GROUP_IDS from code but are NOT in the DB zone list:');
  const nonExistentHqZoneSongs = await q(`
    SELECT zone_id, COUNT(*) AS n
    FROM songs
    WHERE zone_id IN ('zone-003', 'zone-004', 'zone-005', 'loveworld-singers-hq', 'hq')
    GROUP BY zone_id
  `);
  if (nonExistentHqZoneSongs.length === 0) {
    console.log('   → None. No songs reference the phantom HQ zone IDs.');
  } else {
    nonExistentHqZoneSongs.forEach((r: any) =>
      console.log(`   zone_id=${r.zone_id}: ${r.n} songs`)
    );
  }

  // Songs with scope=hq but zone_id set to zone-001 or zone-002 — are these HQ or zone-specific?
  console.log('\n7b. songs WHERE scope=hq AND zone_id IS NOT NULL (cross-signal check):');
  const hqScopeWithZone = await q(`
    SELECT zone_id, COUNT(*) AS n FROM songs
    WHERE scope = 'hq' AND zone_id IS NOT NULL
    GROUP BY zone_id ORDER BY n DESC LIMIT 10
  `);
  if (hqScopeWithZone.length === 0) {
    console.log('   → 0 songs have both scope=hq AND zone_id set.');
    console.log('   (scope and zone_id are mutually exclusive in practice)');
  } else {
    hqScopeWithZone.forEach((r: any) =>
      console.log(`   zone_id=${r.zone_id}: ${r.n} songs with scope=hq`)
    );
  }

  // subgroup members — are subgroup_ids valid?
  console.log('\n7c. Subgroup member distribution:');
  const subgroupMemberDist = await q(`
    SELECT p.subgroup_id, s.name AS subgroup_name, COUNT(*) AS member_count
    FROM profiles p
    LEFT JOIN subgroups s ON s.id = p.subgroup_id
    WHERE p.subgroup_id IS NOT NULL
    GROUP BY p.subgroup_id, s.name
    ORDER BY member_count DESC
  `);
  subgroupMemberDist.forEach((r: any) =>
    console.log(`   ${String(r.subgroup_id).padEnd(30)} "${r.subgroup_name ?? '⚠ NO NAME'}" → ${r.member_count} members`)
  );

  // Analytics — is analytics_events already the target table or the old blob table?
  console.log('\n7d. analytics_events column structure:');
  const analyticsColumns = await q(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'analytics_events'
    ORDER BY ordinal_position
  `);
  analyticsColumns.forEach((c: any) => console.log(`   ${c.column_name}: ${c.data_type}`));

  // media_comments — already exists, what does it contain?
  console.log('\n7e. media_comments (pre-existing table) structure and data:');
  const mediaCommentsColumns = await q(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'media_comments'
    ORDER BY ordinal_position
  `);
  const mediaCommentsCount = await q(`SELECT COUNT(*) AS n FROM media_comments`);
  const mediaCommentsSample = await q(`SELECT * FROM media_comments LIMIT 3`);
  console.log(`   Columns: ${mediaCommentsColumns.map((c: any) => c.column_name).join(', ')}`);
  console.log(`   Row count: ${mediaCommentsCount[0].n}`);
  if (mediaCommentsSample.length > 0) {
    console.log(`   Sample: ${JSON.stringify(mediaCommentsSample[0]).slice(0, 200)}`);
  }

  report.sections.crossChecks = {
    phantomHqZoneSongs: nonExistentHqZoneSongs,
    hqScopeWithZoneSet: hqScopeWithZone,
    subgroupMemberDistribution: subgroupMemberDist,
    analyticsEventsColumns: analyticsColumns,
    mediaComments: {
      columns: mediaCommentsColumns,
      count: mediaCommentsCount[0].n,
      sample: mediaCommentsSample,
    },
  };

  // Write full JSON report
  const reportPath = path.join(process.cwd(), 'ownership_resolution_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  ✅ Ownership Resolution Complete (READ-ONLY)');
  console.log(`  Full JSON report: ${reportPath}`);
  console.log('═'.repeat(60));

  await pool.end();
}

main().catch(err => { console.error('FAILED:', err); pool.end(); process.exit(1); });
