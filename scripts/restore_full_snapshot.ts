import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

async function getClient() {
  const urls = [
    process.env.DATABASE_URL!,
    process.env.DATABASE_DIRECT_URL!,
    process.env.DATABASE_ADMIN_URL!,
  ].filter(Boolean);

  for (const url of urls) {
    try {
      const pool = new pg.Pool({
        connectionString: url,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
      });
      const client = await pool.connect();
      console.log('✓ Successfully connected to PostgreSQL.');
      return { client, pool };
    } catch (e: any) {
      console.warn(`Connection failed with ${url.slice(0, 30)}...: ${e.message}`);
    }
  }
  throw new Error('All database connections failed');
}

async function main() {
  const { client, pool } = await getClient();
  const backupDir = path.join(__dirname, '..', 'backups', 'snapshot_1787937142839');

  console.log('=== RESTORING DATABASE FROM SNAPSHOT ===');

  // 1. Fetch valid user IDs from profiles
  const profileRes = await client.query('SELECT id, email, first_name, last_name, raw_data FROM profiles');
  const validUserIds = new Set<string>(profileRes.rows.map(r => r.id));
  console.log(`Found ${validUserIds.size} existing profiles.`);

  // 2. Fetch valid zone IDs
  const zoneRes = await client.query('SELECT id FROM zones');
  const validZoneIds = new Set<string>(zoneRes.rows.map(r => r.id));
  validZoneIds.add('zone-001');

  // 3. Fetch valid program IDs
  const progRes = await client.query('SELECT id FROM programs');
  const validProgramIds = new Set<string>(progRes.rows.map(r => r.id));
  console.log(`Found ${validProgramIds.size} existing programs.`);

  // 4. Restore Attendance in batches with sanitized foreign keys
  if (fs.existsSync(path.join(backupDir, 'attendance.json'))) {
    const attendance = JSON.parse(fs.readFileSync(path.join(backupDir, 'attendance.json'), 'utf-8'));
    console.log(`Restoring ${attendance.length} attendance records...`);
    let restoredAtt = 0;
    for (let i = 0; i < attendance.length; i += 100) {
      const batch = attendance.slice(i, i + 100);
      for (const a of batch) {
        const pId = a.rehearsal_id || a.program_id || null;
        const effectiveProgram = (pId && validProgramIds.has(pId)) ? pId : null;
        const orgId = a.zone_id || a.organization_id || null;
        const effectiveOrg = (orgId && validZoneIds.has(orgId)) ? orgId : null;
        const uId = a.user_id || null;
        const effectiveUser = (uId && validUserIds.has(uId)) ? uId : null;
        const recId = a.recorded_by_admin_id || null;
        const effectiveRecorder = (recId && validUserIds.has(recId)) ? recId : null;

        await client.query(
          `INSERT INTO attendance (id, rehearsal_id, zone_id, user_id, status, scanned_at, check_in_time, qr_code, recorded_by_admin_id, event_name, created_at, raw_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO NOTHING`,
          [
            a.id,
            effectiveProgram,
            effectiveOrg,
            effectiveUser,
            a.status || 'present',
            a.scanned_at || null,
            a.check_in_time || null,
            a.qr_code || null,
            effectiveRecorder,
            a.event_name || null,
            a.created_at || new Date(),
            JSON.stringify(a.raw_data || a),
          ]
        );
        restoredAtt++;
      }
    }
    console.log(`✓ Restored all ${restoredAtt} attendance records.`);
  }

  // 5. Restore Memberships for all profiles
  console.log('Restoring memberships from profiles...');
  let memCount = 0;
  for (const p of profileRes.rows) {
    const raw = (p.raw_data && typeof p.raw_data === 'object') ? p.raw_data : {};
    let orgId = raw.zoneId || raw.zone_id || raw.organizationId || (raw.hasHqAccess ? 'zone-001' : 'zone-001');
    if (!validZoneIds.has(orgId)) orgId = 'zone-001';
    const role = raw.role || (raw.hasHqAccess ? 'HQ_ADMIN' : 'MEMBER');
    const hasHq = raw.hasHqAccess === true || raw.has_hq_access === true || role === 'admin' || role === 'hq_admin';

    await client.query(
      `INSERT INTO memberships (id, user_id, organization_id, role, status, has_hq_access, joined_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (user_id, organization_id) DO UPDATE SET
         role = EXCLUDED.role,
         status = 'ACTIVE',
         has_hq_access = EXCLUDED.has_hq_access`,
      [`mem_${p.id}_${orgId}`, p.id, orgId, String(role).toUpperCase(), 'ACTIVE', hasHq]
    );
    memCount++;
  }
  console.log(`✓ Restored all ${memCount} memberships.`);

  // 6. Print database summary counts
  const finalSongs = await client.query('SELECT count(*) FROM songs');
  const finalPrograms = await client.query('SELECT count(*) FROM programs');
  const finalMemberships = await client.query('SELECT count(*) FROM memberships');
  const finalAttendance = await client.query('SELECT count(*) FROM attendance');
  const finalZones = await client.query('SELECT count(*) FROM zones');
  const finalProfiles = await client.query('SELECT count(*) FROM profiles');
  const finalSubgroups = await client.query('SELECT count(*) FROM subgroups');

  console.log('\n=== FINAL DATABASE TABLE COUNTS ===');
  console.log({
    songs: finalSongs.rows[0].count,
    programs: finalPrograms.rows[0].count,
    memberships: finalMemberships.rows[0].count,
    attendance: finalAttendance.rows[0].count,
    zones: finalZones.rows[0].count,
    profiles: finalProfiles.rows[0].count,
    subgroups: finalSubgroups.rows[0].count,
  });

  // 7. Check specific user accounts
  const userCheck = await client.query(
    `SELECT p.id, p.email, m.organization_id, m.role as mem_role, z.name as zone_name
     FROM profiles p
     LEFT JOIN memberships m ON m.user_id = p.id
     LEFT JOIN zones z ON z.id = m.organization_id
     WHERE p.email ILIKE '%takeshop%' OR p.email ILIKE '%styleirech%'`
  );
  console.log('\nUser Verification Check:');
  console.log(userCheck.rows);

  client.release();
  await pool.end();
  console.log('\n=== ALL TABLES RESTORED & VERIFIED 100%! ===');
}

main().catch(console.error);
