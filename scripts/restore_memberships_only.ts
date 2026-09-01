import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();
  console.log('=== RESTORING ALL USER MEMBERSHIPS ===');

  // 1. Get valid zones
  const zonesRes = await client.query('SELECT id FROM zones');
  const validZones = new Set<string>(zonesRes.rows.map(z => z.id));
  validZones.add('zone-001');

  // 2. Get all profiles
  const profilesRes = await client.query('SELECT id, email, first_name, last_name, raw_data FROM profiles');
  console.log(`Found ${profilesRes.rows.length} profiles to restore memberships for.`);

  let restored = 0;
  for (const p of profilesRes.rows) {
    const raw = (p.raw_data && typeof p.raw_data === 'object') ? p.raw_data : {};
    let orgId = raw.zoneId || raw.zone_id || raw.organizationId || 'zone-001';
    if (!validZones.has(orgId)) orgId = 'zone-001';
    
    const rawRole = String(raw.role || (raw.hasHqAccess ? 'HQ_ADMIN' : 'MEMBER')).toUpperCase();
    const role = ['ADMIN', 'HQ_ADMIN', 'ZONE_ADMIN', 'SUBGROUP_ADMIN', 'MEMBER'].includes(rawRole) ? rawRole : 'MEMBER';
    const hasHq = raw.hasHqAccess === true || raw.has_hq_access === true || role === 'ADMIN' || role === 'HQ_ADMIN';

    await client.query(
      `INSERT INTO memberships (id, user_id, organization_id, role, status, has_hq_access, joined_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (user_id, organization_id) DO UPDATE SET
         role = EXCLUDED.role,
         status = 'ACTIVE',
         has_hq_access = EXCLUDED.has_hq_access`,
      [`mem_${p.id}_${orgId}`, p.id, orgId, role, 'ACTIVE', hasHq]
    );
    restored++;
  }

  console.log(`✓ Restored ${restored} memberships.`);

  const countRes = await client.query('SELECT count(*) FROM memberships');
  console.log(`Total Memberships in DB now: ${countRes.rows[0].count}`);

  // Verification of key users
  const verifyRes = await client.query(
    `SELECT p.id, p.email, m.organization_id, m.role, z.name as zone_name
     FROM profiles p
     JOIN memberships m ON m.user_id = p.id
     JOIN zones z ON z.id = m.organization_id
     WHERE p.email ILIKE '%takeshop%' OR p.email ILIKE '%styleirech%' OR p.email ILIKE '%anna%'`
  );
  console.log('\nVerified Sample Memberships:');
  console.table(verifyRes.rows);

  client.release();
  await pool.end();
  console.log('\n=== MEMBERSHIP RESTORATION COMPLETE! ===');
}

main().catch(console.error);
