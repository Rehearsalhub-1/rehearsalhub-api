/**
 * RehearsalHub — Migration Audit Script
 * READ-ONLY. Makes zero writes or schema changes.
 *
 * Run: npx tsx audit_migration.ts
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
async function count(table: string, where = ''): Promise<number> {
  const rows = await q(`SELECT COUNT(*) AS n FROM ${table} ${where}`);
  return Number(rows[0]?.n ?? 0);
}
async function nullRate(table: string, col: string): Promise<string> {
  const total = await count(table);
  if (total === 0) return 'N/A (empty)';
  const nulls = await count(table, `WHERE ${col} IS NULL`);
  return `${nulls}/${total} (${((nulls / total) * 100).toFixed(1)}% null)`;
}
async function sample(table: string, limit = 3): Promise<any[]> {
  return q(`SELECT * FROM ${table} LIMIT ${limit}`);
}
async function distinctValues(table: string, col: string): Promise<string[]> {
  const rows = await q(
    `SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL ORDER BY v LIMIT 30`
  );
  return rows.map((r) => String(r.v));
}
async function tableExists(table: string): Promise<boolean> {
  const rows = await q(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return rows.length > 0;
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  RehearsalHub — Migration Audit (READ-ONLY)');
  console.log('══════════════════════════════════════════════════════\n');

  const report: Record<string, any> = {
    auditedAt: new Date().toISOString(),
    tables: {},
    backfillPlans: {},
    orphans: {},
    warnings: [],
  };

  // 1. ROW COUNTS
  console.log('▶ 1. Row counts...');
  const tables = [
    'zones','subgroups','profiles','auth_credentials','refresh_tokens',
    'songs','programs','playlists','categories',
    'media_assets','chats','messages','notifications',
    'attendance','admin_requests','submitted_songs','support_tickets',
    'media_doodles','watch_history','song_history','user_song_notes',
    'activity_logs','analytics_sessions','analytics_events',
    'analytics_monthly','simplified_analytics',
    'audiolab_projects','audiolab_sessions','audiolab_progress',
    'user_sessions','user_statuses','presence','calls',
    'app_settings','settings','system_metadata','achievement_templates',
  ];
  const rowCounts: Record<string, number> = {};
  for (const t of tables) {
    const exists = await tableExists(t);
    rowCounts[t] = exists ? await count(t) : -1;
    console.log(`   ${t.padEnd(32)} ${rowCounts[t] === -1 ? '⚠ MISSING' : rowCounts[t].toLocaleString()}`);
  }
  report.rowCounts = rowCounts;

  // 2. ZONES
  console.log('\n▶ 2. Zones...');
  const zones = await q(`SELECT id, name, code, is_hq, is_active FROM zones ORDER BY is_hq DESC NULLS LAST`);
  report.tables.zones = {
    count: zones.length,
    hqCount: zones.filter((z: any) => z.is_hq).length,
    all: zones,
  };
  zones.forEach((z: any) => console.log(`   ${JSON.stringify(z)}`));

  // 3. PROFILES
  console.log('\n▶ 3. Profiles...');
  const profileRoles = await distinctValues('profiles', 'role');
  const orphanProfiles = await q(`
    SELECT p.id, p.zone_id, p.role FROM profiles p
    LEFT JOIN zones z ON z.id = p.zone_id
    WHERE p.zone_id IS NOT NULL AND z.id IS NULL LIMIT 20
  `);
  const orphanSubProfiles = await q(`
    SELECT p.id, p.subgroup_id FROM profiles p
    LEFT JOIN subgroups s ON s.id = p.subgroup_id
    WHERE p.subgroup_id IS NOT NULL AND s.id IS NULL LIMIT 20
  `);
  report.tables.profiles = {
    nullZoneId: await nullRate('profiles', 'zone_id'),
    nullEmail: await nullRate('profiles', 'email'),
    distinctRoles: profileRoles,
    withBothZoneAndSubgroup: await count('profiles', 'WHERE zone_id IS NOT NULL AND subgroup_id IS NOT NULL'),
    withZoneOnly: await count('profiles', 'WHERE zone_id IS NOT NULL AND subgroup_id IS NULL'),
    withNeither: await count('profiles', 'WHERE zone_id IS NULL AND subgroup_id IS NULL'),
    orphanZoneIds: orphanProfiles,
    orphanSubgroupIds: orphanSubProfiles,
  };
  console.log(`   Roles: ${profileRoles.join(', ')}`);
  console.log(`   Orphan zone_ids: ${orphanProfiles.length}, orphan subgroup_ids: ${orphanSubProfiles.length}`);
  report.orphans.profiles_bad_zone = orphanProfiles;

  // 4. SONGS
  console.log('\n▶ 4. Songs...');
  const orphanPraiseNightIds = await q(`
    SELECT s.id, s.title, s.praise_night_id FROM songs s
    LEFT JOIN programs p ON p.id = s.praise_night_id
    WHERE s.praise_night_id IS NOT NULL AND p.id IS NULL LIMIT 20
  `);
  report.tables.songs = {
    distinctScopes: await distinctValues('songs', 'scope'),
    nullZoneId: await nullRate('songs', 'zone_id'),
    withPraiseNightId: await count('songs', 'WHERE praise_night_id IS NOT NULL'),
    orphanPraiseNightIds,
    withConductor: await count('songs', "WHERE conductor IS NOT NULL AND conductor != ''"),
    withLeadSinger: await count('songs', "WHERE lead_singer IS NOT NULL AND lead_singer != ''"),
    withDrummer: await count('songs', "WHERE drummer IS NOT NULL AND drummer != ''"),
    withLeadKeyboardist: await count('songs', "WHERE lead_keyboardist IS NOT NULL AND lead_keyboardist != ''"),
    withLeadGuitarist: await count('songs', "WHERE lead_guitarist IS NOT NULL AND lead_guitarist != ''"),
    withBassGuitarist: await count('songs', "WHERE bass_guitarist IS NOT NULL AND bass_guitarist != ''"),
    withCategoriesJson: await count('songs', 'WHERE categories IS NOT NULL'),
    praiseNightSample: await q('SELECT id, title, praise_night_id FROM songs WHERE praise_night_id IS NOT NULL LIMIT 5'),
  };
  console.log(`   Orphan praise_night_ids: ${orphanPraiseNightIds.length}`);
  console.log(`   Scopes: ${report.tables.songs.distinctScopes.join(', ')}`);
  report.orphans.songs_bad_praise_night = orphanPraiseNightIds;

  // 5. PROGRAMS
  console.log('\n▶ 5. Programs...');
  report.tables.programs = {
    distinctScopes: await distinctValues('programs', 'scope'),
    nullZoneId: await nullRate('programs', 'zone_id'),
    withSongsJson: await count('programs', 'WHERE songs IS NOT NULL'),
    withSongIds: await count('programs', 'WHERE song_ids IS NOT NULL'),
    sampleSongCounts: await q(`
      SELECT id, name,
        CASE WHEN jsonb_typeof(songs::jsonb) = 'array'
          THEN jsonb_array_length(songs::jsonb) ELSE 0 END AS songs_len,
        CASE WHEN jsonb_typeof(song_ids::jsonb) = 'array'
          THEN jsonb_array_length(song_ids::jsonb) ELSE 0 END AS song_ids_len
      FROM programs WHERE songs IS NOT NULL OR song_ids IS NOT NULL LIMIT 5
    `),
  };
  console.log(`   Scopes: ${report.tables.programs.distinctScopes.join(', ')}`);

  // 6. PLAYLISTS
  console.log('\n▶ 6. Playlists...');
  const orphanPlaylistUsers = await q(`
    SELECT pl.id, pl.user_id FROM playlists pl
    LEFT JOIN profiles p ON p.id = pl.user_id
    WHERE pl.user_id IS NOT NULL AND p.id IS NULL LIMIT 10
  `);
  report.tables.playlists = {
    distinctScopes: await distinctValues('playlists', 'scope'),
    nullUserId: await nullRate('playlists', 'user_id'),
    withSongsJson: await count('playlists', 'WHERE songs IS NOT NULL'),
    withSongIds: await count('playlists', 'WHERE song_ids IS NOT NULL'),
    orphanUserIds: orphanPlaylistUsers,
  };
  console.log(`   Orphan user_ids: ${orphanPlaylistUsers.length}`);

  // 7. CHATS
  console.log('\n▶ 7. Chats...');
  const chatSample = await q(`
    SELECT id, type,
      jsonb_typeof(participants::jsonb) AS participants_type,
      CASE WHEN jsonb_typeof(participants::jsonb) = 'array'
        THEN jsonb_array_length(participants::jsonb) ELSE NULL END AS participant_count,
      participants::jsonb -> 0 AS first_participant
    FROM chats WHERE participants IS NOT NULL LIMIT 5
  `);
  report.tables.chats = {
    nullCreatedBy: await nullRate('chats', 'created_by'),
    withParticipantsJson: await count('chats', 'WHERE participants IS NOT NULL'),
    withUnreadJson: await count('chats', 'WHERE unread_count IS NOT NULL'),
    participantSample: chatSample,
  };
  console.log(`   Participant sample:`, JSON.stringify(chatSample.slice(0,2), null, 2).slice(0, 300));

  // 8. NOTIFICATIONS
  console.log('\n▶ 8. Notifications...');
  report.tables.notifications = {
    distinctTypes: await distinctValues('notifications', 'type'),
    nullZoneId: await nullRate('notifications', 'zone_id'),
    broadcastCount: await count('notifications', 'WHERE target_audience IS NOT NULL'),
    targetedCount: await count('notifications', 'WHERE target_user_id IS NOT NULL AND target_audience IS NULL'),
    systemCount: await count('notifications', 'WHERE target_audience IS NULL AND target_user_id IS NULL'),
    withSenderId: await count('notifications', 'WHERE sender_id IS NOT NULL'),
    sample: await sample('notifications', 2),
  };
  console.log(`   Types: ${report.tables.notifications.distinctTypes.join(', ')}`);

  // 9. ATTENDANCE
  console.log('\n▶ 9. Attendance...');
  const orphanAttUser = await q(`
    SELECT a.id, a.user_id FROM attendance a
    LEFT JOIN profiles p ON p.id = a.user_id
    WHERE a.user_id IS NOT NULL AND p.id IS NULL LIMIT 10
  `);
  const orphanAttRehearsal = await q(`
    SELECT a.id, a.rehearsal_id FROM attendance a
    LEFT JOIN programs pr ON pr.id = a.rehearsal_id
    WHERE a.rehearsal_id IS NOT NULL AND pr.id IS NULL LIMIT 10
  `);
  report.tables.attendance = {
    nullUserId: await nullRate('attendance', 'user_id'),
    nullRehearsalId: await nullRate('attendance', 'rehearsal_id'),
    nullZoneId: await nullRate('attendance', 'zone_id'),
    orphanUserIds: orphanAttUser,
    orphanRehearsalIds: orphanAttRehearsal,
  };
  report.orphans.attendance_bad_user = orphanAttUser;
  report.orphans.attendance_bad_rehearsal = orphanAttRehearsal;
  console.log(`   Orphan user_ids: ${orphanAttUser.length}, orphan rehearsal_ids: ${orphanAttRehearsal.length}`);

  // 10. SUBGROUPS
  console.log('\n▶ 10. Subgroups...');
  const orphanSubgroupZone = await q(`
    SELECT s.id, s.name, s.zone_id FROM subgroups s
    LEFT JOIN zones z ON z.id = s.zone_id
    WHERE s.zone_id IS NOT NULL AND z.id IS NULL LIMIT 10
  `);
  const orphanCoordinators = await q(`
    SELECT s.id, s.coordinator_id FROM subgroups s
    LEFT JOIN profiles p ON p.id = s.coordinator_id
    WHERE s.coordinator_id IS NOT NULL AND p.id IS NULL LIMIT 10
  `);
  report.tables.subgroups = {
    coordinatorIdPopulated: await count('subgroups', 'WHERE coordinator_id IS NOT NULL'),
    orphanZoneIds: orphanSubgroupZone,
    orphanCoordinatorIds: orphanCoordinators,
  };
  console.log(`   Orphan zone_ids: ${orphanSubgroupZone.length}, orphan coordinator_ids: ${orphanCoordinators.length}`);

  // 11. ADMIN REQUESTS
  console.log('\n▶ 11. Admin Requests...');
  report.tables.adminRequests = {
    statuses: await distinctValues('admin_requests', 'status'),
    requestedRoles: await distinctValues('admin_requests', 'requested_role'),
  };

  // 12. SETTINGS
  console.log('\n▶ 12. Settings tables...');
  for (const t of ['app_settings', 'settings', 'system_metadata']) {
    if (await tableExists(t) && rowCounts[t] > 0) {
      const s = await sample(t, 2);
      report.tables[t] = { count: rowCounts[t], samples: s };
      console.log(`   ${t}: ${rowCounts[t]} rows`);
      s.forEach((row: any) => console.log(`     ${JSON.stringify(row).slice(0, 120)}`));
    }
  }

  // 13. ANALYTICS & AUDIOLAB BLOBS
  console.log('\n▶ 13. Blob tables (analytics + audiolab)...');
  for (const t of [
    'activity_logs','analytics_sessions','analytics_events','analytics_monthly','simplified_analytics',
    'audiolab_projects','audiolab_sessions','audiolab_progress',
  ]) {
    if (rowCounts[t] > 0) {
      const s = await sample(t, 1);
      const keys = s[0]?.raw_data ? Object.keys(s[0].raw_data as object) : ['(no raw_data col)'];
      report.tables[t] = { count: rowCounts[t], rawDataKeys: keys };
      console.log(`   ${t}: ${rowCounts[t]} rows, rawData keys: [${keys.join(', ')}]`);
    } else {
      console.log(`   ${t}: ${rowCounts[t] === -1 ? '⚠ MISSING' : '0 rows'}`);
    }
  }

  // 14. SCOPE DISTRIBUTION
  console.log('\n▶ 14. Scope distribution...');
  for (const [tbl, col] of [['songs','scope'],['programs','scope'],['playlists','scope']] as [string,string][]) {
    if (rowCounts[tbl] > 0) {
      const dist = await q(`SELECT ${col} AS v, COUNT(*) AS n FROM ${tbl} GROUP BY ${col} ORDER BY n DESC`);
      report.tables[`${tbl}_scope_dist`] = dist;
      console.log(`   ${tbl}.${col}: ${dist.map((d: any) => `${d.v ?? 'NULL'}=${d.n}`).join(', ')}`);
    }
  }

  // 15. ZONE ID INTEGRITY ACROSS ALL TABLES
  console.log('\n▶ 15. Zone ID referential integrity...');
  const tenantTables2 = [
    'songs','programs','playlists','media_assets','categories',
    'notifications','attendance','admin_requests','submitted_songs','support_tickets',
  ];
  report.zoneIdIntegrity = {};
  for (const t of tenantTables2) {
    if (!(await tableExists(t))) continue;
    const total = rowCounts[t];
    const withZone = await count(t, 'WHERE zone_id IS NOT NULL');
    const orphans = await q(`
      SELECT t.id, t.zone_id FROM ${t} t
      LEFT JOIN zones z ON z.id = t.zone_id
      WHERE t.zone_id IS NOT NULL AND z.id IS NULL LIMIT 5
    `);
    const distinctZones = await q(`SELECT DISTINCT zone_id AS zid FROM ${t} WHERE zone_id IS NOT NULL`);
    report.zoneIdIntegrity[t] = {
      total, withZoneId: withZone, nullZoneId: total - withZone,
      orphanCount: orphans.length, orphanSamples: orphans,
      distinctZoneIds: distinctZones.map((r: any) => r.zid),
    };
    console.log(`   ${t.padEnd(22)} total=${total} zone_set=${withZone} null=${total-withZone} orphans=${orphans.length}`);
  }

  // 16. NEW TABLES CHECK
  console.log('\n▶ 16. New join tables (should not exist yet)...');
  for (const t of [
    'memberships','program_songs','playlist_items','chat_participants',
    'song_role_assignments','broadcast_notifications','notification_deliveries',
    'song_categories','media_comments',
  ]) {
    const exists = await tableExists(t);
    console.log(`   ${t.padEnd(35)} ${exists ? '⚠ ALREADY EXISTS' : '✓ not yet created'}`);
    if (exists) report.warnings.push(`New table pre-exists: ${t}`);
  }

  const reportPath = path.join(process.cwd(), 'migration_audit_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n✅ Audit complete. Full report: ${reportPath}`);
  await pool.end();
}

main().catch((err) => { console.error('Audit failed:', err); pool.end(); process.exit(1); });
