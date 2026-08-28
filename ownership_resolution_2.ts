/**
 * RehearsalHub — Sections 4, 5, 7 Only (READ-ONLY)
 * Fixes column references to use live DB columns (zone_id not organization_id)
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

async function main() {
  const report: Record<string, any> = { generatedAt: new Date().toISOString() };

  // ── SECTION 4: ORPHAN RECORDS ──────────────────────────────
  console.log('\n════════════ SECTION 4 — Orphan Records ════════════');

  console.log('\n4a. Songs with orphan zone_id:');
  const orphanSongs = await q(`
    SELECT s.id, s.title, s.zone_id, s.scope
    FROM songs s LEFT JOIN zones z ON z.id = s.zone_id
    WHERE s.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanSongs.forEach((s: any) => console.log('  ', JSON.stringify(s)));
  report.orphanSongs = orphanSongs;

  console.log('\n4b. Songs with orphan praise_night_id (no matching program):');
  const orphanPraiseNight = await q(`
    SELECT s.id, s.title, s.praise_night_id, s.zone_id, s.scope
    FROM songs s LEFT JOIN programs p ON p.id = s.praise_night_id
    WHERE s.praise_night_id IS NOT NULL AND p.id IS NULL
  `);
  orphanPraiseNight.forEach((s: any) => console.log('  ', JSON.stringify(s)));
  report.orphanPraiseNight = orphanPraiseNight;

  console.log('\n4c. Submitted songs with orphan zone_id:');
  const orphanSubmitted = await q(`
    SELECT ss.id, ss.zone_id, ss.status,
      ss.raw_data->>'title' AS title,
      ss.raw_data->>'zoneId' AS raw_zone
    FROM submitted_songs ss LEFT JOIN zones z ON z.id = ss.zone_id
    WHERE ss.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanSubmitted.forEach((s: any) => console.log('  ', JSON.stringify(s)));
  report.orphanSubmitted = orphanSubmitted;

  console.log('\n4d. Notifications with orphan zone_id:');
  const orphanNotifs = await q(`
    SELECT n.id, n.zone_id, n.type, n.title
    FROM notifications n LEFT JOIN zones z ON z.id = n.zone_id
    WHERE n.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanNotifs.forEach((n: any) => console.log('  ', JSON.stringify(n)));
  report.orphanNotifs = orphanNotifs;

  console.log('\n4e. Attendance records with orphan user_id:');
  const orphanAtt = await q(`
    SELECT a.id, a.user_id, a.rehearsal_id, a.zone_id, a.status, a.created_at
    FROM attendance a LEFT JOIN profiles p ON p.id = a.user_id
    WHERE a.user_id IS NOT NULL AND p.id IS NULL
  `);
  orphanAtt.forEach((a: any) => console.log('  ', JSON.stringify(a)));
  report.orphanAtt = orphanAtt;

  console.log('\n4f. Attendance with orphan zone_id:');
  const orphanAttZone = await q(`
    SELECT a.id, a.user_id, a.zone_id, a.status
    FROM attendance a LEFT JOIN zones z ON z.id = a.zone_id
    WHERE a.zone_id IS NOT NULL AND z.id IS NULL
  `);
  orphanAttZone.forEach((a: any) => console.log('  ', JSON.stringify(a)));
  report.orphanAttZone = orphanAttZone;

  // ── SECTION 5: EXACT JOIN TABLE COUNTS ────────────────────
  console.log('\n════════════ SECTION 5 — Join Table Row Estimates ════════════');

  // program_songs
  const psSongs = await q(`
    SELECT COUNT(*) AS total FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(song_ids::jsonb)='array' THEN song_ids::jsonb ELSE '[]'::jsonb END
      ) AS sid FROM programs WHERE song_ids IS NOT NULL
    ) sub WHERE sid IS NOT NULL AND sid != ''
  `);
  const psSongsValid = await q(`
    SELECT COUNT(*) AS valid FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(song_ids::jsonb)='array' THEN song_ids::jsonb ELSE '[]'::jsonb END
      ) AS sid FROM programs WHERE song_ids IS NOT NULL
    ) sub WHERE sid IS NOT NULL AND sid != ''
      AND EXISTS (SELECT 1 FROM songs WHERE id = sub.sid)
  `);
  const psAlsoSongsJson = await q(`
    SELECT COUNT(*) AS total FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(songs::jsonb)='array' THEN songs::jsonb ELSE '[]'::jsonb END
      ) AS sid FROM programs WHERE songs IS NOT NULL
    ) sub WHERE sid IS NOT NULL AND sid != ''
  `);
  console.log(`\n5a. program_songs:`);
  console.log(`   Total entries in song_ids arrays: ${psSongs[0].total}`);
  console.log(`   Valid (song exists):              ${psSongsValid[0].valid}`);
  console.log(`   Also in songs Json column:        ${psAlsoSongsJson[0].total}`);

  const perProgramSongs = await q(`
    SELECT p.id, p.name,
      jsonb_array_length(CASE WHEN jsonb_typeof(p.song_ids::jsonb)='array' THEN p.song_ids::jsonb ELSE '[]'::jsonb END) AS song_count
    FROM programs p WHERE song_ids IS NOT NULL
    ORDER BY song_count DESC LIMIT 10
  `);
  console.log('   Top 10 programs by song count:');
  perProgramSongs.forEach((p: any) => console.log(`     "${String(p.name ?? '').slice(0,45).padEnd(47)}" ${p.song_count} songs`));
  report.programSongs = { total: psSongs[0].total, valid: psSongsValid[0].valid, top10: perProgramSongs };

  // playlist_items
  const plItems = await q(`
    SELECT COUNT(*) AS total FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(song_ids::jsonb)='array' THEN song_ids::jsonb ELSE '[]'::jsonb END
      ) AS sid FROM playlists WHERE song_ids IS NOT NULL
    ) sub WHERE sid IS NOT NULL AND sid != ''
  `);
  const plItemsValid = await q(`
    SELECT COUNT(*) AS valid FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(song_ids::jsonb)='array' THEN song_ids::jsonb ELSE '[]'::jsonb END
      ) AS sid FROM playlists WHERE song_ids IS NOT NULL
    ) sub WHERE sid IS NOT NULL AND sid != ''
      AND EXISTS (SELECT 1 FROM songs WHERE id = sub.sid)
  `);
  console.log(`\n5b. playlist_items:`);
  console.log(`   Total entries in song_ids arrays: ${plItems[0].total}`);
  console.log(`   Valid (song exists):              ${plItemsValid[0].valid}`);
  report.playlistItems = { total: plItems[0].total, valid: plItemsValid[0].valid };

  // chat_participants
  const cpCount = await q(`
    SELECT COUNT(*) AS total FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(participants::jsonb)='array' THEN participants::jsonb ELSE '[]'::jsonb END
      ) AS uid FROM chats WHERE participants IS NOT NULL
    ) sub WHERE uid IS NOT NULL AND uid != ''
  `);
  const cpValid = await q(`
    SELECT COUNT(*) AS valid FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(participants::jsonb)='array' THEN participants::jsonb ELSE '[]'::jsonb END
      ) AS uid FROM chats WHERE participants IS NOT NULL
    ) sub WHERE uid IS NOT NULL AND uid != ''
      AND EXISTS (SELECT 1 FROM profiles WHERE id = sub.uid)
  `);
  const cpStats = await q(`
    SELECT AVG(jsonb_array_length(participants::jsonb)) AS avg_p,
           MAX(jsonb_array_length(participants::jsonb)) AS max_p
    FROM chats WHERE jsonb_typeof(participants::jsonb)='array'
  `);
  console.log(`\n5c. chat_participants:`);
  console.log(`   Total participant entries:        ${cpCount[0].total}`);
  console.log(`   Valid (user exists):              ${cpValid[0].valid}`);
  console.log(`   Avg per chat: ${Number(cpStats[0]?.avg_p||0).toFixed(1)}, Max: ${cpStats[0]?.max_p}`);
  report.chatParticipants = { total: cpCount[0].total, valid: cpValid[0].valid, stats: cpStats[0] };

  // memberships
  const mWithZone = await q(`SELECT COUNT(*) AS n FROM profiles WHERE zone_id IS NOT NULL`);
  const mNoZone = await q(`SELECT COUNT(*) AS n FROM profiles WHERE zone_id IS NULL`);
  console.log(`\n5d. memberships:`);
  console.log(`   Profiles with zone_id (clear):   ${mWithZone[0].n}`);
  console.log(`   Profiles without zone_id:        ${mNoZone[0].n}`);
  report.memberships = { clear: mWithZone[0].n, needsReview: mNoZone[0].n };

  // ── SECTION 7: CROSS-CHECKS ────────────────────────────────
  console.log('\n════════════ SECTION 7 — Cross-Checks ════════════');

  console.log('\n7a. Songs using phantom HQ zone IDs (zone-003, loveworld-singers-hq, hq):');
  const phantomHqSongs = await q(`
    SELECT zone_id, COUNT(*) AS n FROM songs
    WHERE zone_id IN ('zone-003','loveworld-singers-hq','hq')
    GROUP BY zone_id
  `);
  if (phantomHqSongs.length === 0) console.log('   → NONE. No songs reference phantom HQ IDs.');
  else phantomHqSongs.forEach((r: any) => console.log(`   ${r.zone_id}: ${r.n} songs`));

  console.log('\n7b. songs WHERE scope=hq AND zone_id IS NOT NULL:');
  const hqScopeWithZone = await q(`
    SELECT zone_id, COUNT(*) AS n FROM songs
    WHERE scope='hq' AND zone_id IS NOT NULL
    GROUP BY zone_id ORDER BY n DESC LIMIT 10
  `);
  hqScopeWithZone.forEach((r: any) => console.log(`   zone_id=${r.zone_id}: ${r.n} songs with scope=hq`));
  if (hqScopeWithZone.length === 0) console.log('   → scope=hq and zone_id are mutually exclusive in practice.');

  console.log('\n7c. Subgroup member distribution:');
  const subgroupDist = await q(`
    SELECT p.subgroup_id, s.name, COUNT(*) AS member_count
    FROM profiles p LEFT JOIN subgroups s ON s.id = p.subgroup_id
    WHERE p.subgroup_id IS NOT NULL
    GROUP BY p.subgroup_id, s.name ORDER BY member_count DESC
  `);
  subgroupDist.forEach((r: any) =>
    console.log(`   ${String(r.subgroup_id).padEnd(32)} "${r.name ?? '⚠ NONE'}" → ${r.member_count} members`)
  );
  report.subgroupDist = subgroupDist;

  console.log('\n7d. analytics_events column structure:');
  const analyticsColumns = await q(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='analytics_events'
    ORDER BY ordinal_position
  `);
  analyticsColumns.forEach((c: any) => console.log(`   ${c.column_name}: ${c.data_type}`));
  report.analyticsColumns = analyticsColumns;

  console.log('\n7e. media_comments (pre-existing table):');
  const mcColumns = await q(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='media_comments'
    ORDER BY ordinal_position
  `);
  const mcCount = await q(`SELECT COUNT(*) AS n FROM media_comments`);
  const mcSample = await q(`SELECT * FROM media_comments LIMIT 3`);
  console.log(`   Columns: ${mcColumns.map((c: any) => c.column_name).join(', ')}`);
  console.log(`   Row count: ${mcCount[0].n}`);
  mcSample.forEach((r: any) => console.log(`   Sample: ${JSON.stringify(r).slice(0, 200)}`));
  report.mediaComments = { columns: mcColumns, count: mcCount[0].n, sample: mcSample };

  const outPath = path.join(process.cwd(), 'ownership_resolution_report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n✅ Done. Report: ${outPath}`);
  await pool.end();
}

main().catch(err => { console.error('FAILED:', err); pool.end(); process.exit(1); });
