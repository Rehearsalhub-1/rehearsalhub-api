import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: 'loveworld-singers-app' });
}
const db = admin.firestore();

function safeDate(val: any): string {
  if (!val) return new Date().toISOString();
  if (val?._seconds) return new Date(val._seconds * 1000).toISOString();
  if (val?.toDate) return val.toDate().toISOString();
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
function str(val: any): string | null {
  if (val == null) return null;
  return String(val).trim() || null;
}

async function main() {
  const client = await pool.connect();
  console.log('Migrating subgroups...');
  const snap = await db.collection('subgroups').get();
  let count = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    const orgId = str(d.zoneId || d.zone_id);
    if (!orgId) {
      skipped++;
      console.warn(`  skip ${doc.id}: no zoneId`);
      continue;
    }
    try {
      await client.query(
        `INSERT INTO subgroups (id, organization_id, name, description, type, status, estimated_members, created_at, updated_at, raw_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           estimated_members = EXCLUDED.estimated_members,
           raw_data = EXCLUDED.raw_data`,
        [
          doc.id,
          orgId,
          str(d.name) || 'Unnamed',
          str(d.description),
          str(d.type) || 'church',
          str(d.status) || 'active',
          Number(d.estimatedMembers || 0),
          safeDate(d.createdAt),
          safeDate(d.updatedAt),
          JSON.stringify(d),
        ]
      );
      count++;
    } catch (e: any) {
      console.warn(`  error ${doc.id} (orgId=${orgId}):`, e.message || e.code);
      skipped++;
    }
  }

  client.release();
  console.log(`Done: ${count} inserted, ${skipped} skipped`);
  await admin.app().delete();
  await pool.end();
}

main().catch(console.error);
