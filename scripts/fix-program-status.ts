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

async function main() {
  const client = await pool.connect();

  // Build a map of all Firebase program IDs -> their correct category
  console.log('Reading Firebase programs...');
  const fbMap = new Map<string, string>();
  
  for (const col of ['praise_nights', 'zone_praise_nights', 'master_programs']) {
    const snap = await db.collection(col).get();
    snap.docs.forEach(doc => {
      const d = doc.data();
      fbMap.set(doc.id, d.category || 'archive');
    });
  }
  console.log(`Firebase programs loaded: ${fbMap.size}`);

  // Get all DB programs
  const dbProgs = await client.query(
    `SELECT id, name, status, category, raw_data->>'category' as raw_cat FROM programs`
  );
  
  let fixed = 0;
  let skipped = 0;

  for (const row of dbProgs.rows) {
    const fbCategory = fbMap.get(row.id);
    
    if (!fbCategory) {
      // Program was created after migration — trust the DB value
      skipped++;
      continue;
    }

    // Program came from Firebase — use Firebase category as truth
    if (row.category !== fbCategory || row.status !== fbCategory) {
      await client.query(
        `UPDATE programs SET category = $1, status = $1 WHERE id = $2`,
        [fbCategory, row.id]
      );
      console.log(`Fixed: "${row.name}" | was: ${row.category} -> now: ${fbCategory}`);
      fixed++;
    }
  }

  console.log(`\nDone: ${fixed} fixed, ${skipped} skipped (created after migration)`);
  client.release();
  await admin.app().delete();
  await pool.end();
}
main().catch(console.error);
