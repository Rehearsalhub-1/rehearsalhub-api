/**
 * Fix song-to-program linkages for the Programs page.
 * 
 * Songs from praise_night_songs have praiseNightId referencing praise_nights IDs.
 * Some of those praise_nights records were deleted (replaced by master_programs version).
 * This script finds those orphaned songs and points them to the correct surviving program.
 */
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
  let totalFixed = 0;

  // Step 1: Get all praise_night_id values in songs that DON'T exist in programs table
  const orphanResult = await client.query<{ praise_night_id: string; count: string }>(`
    SELECT s.praise_night_id, COUNT(*) as count
    FROM songs s
    WHERE s.praise_night_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = s.praise_night_id)
    GROUP BY s.praise_night_id
    ORDER BY count DESC
  `);

  console.log(`Found ${orphanResult.rows.length} orphaned praise_night_id values`);

  // Step 2: For each orphaned ID, look it up in Firebase praise_nights to get the name,
  // then find the matching program in DB by name
  const programsByName = await client.query<{ id: string; name: string }>(`SELECT id, name FROM programs`);
  const nameToId = new Map<string, string>();
  programsByName.rows.forEach(r => {
    if (r.name) nameToId.set(r.name.toUpperCase().trim(), r.id);
  });

  for (const row of orphanResult.rows) {
    const oldId = row.praise_night_id;
    const songCount = parseInt(row.count);

    // Look up in Firebase
    let fbName: string | null = null;
    for (const col of ['praise_nights', 'zone_praise_nights']) {
      try {
        const doc = await db.collection(col).doc(oldId).get();
        if (doc.exists) {
          fbName = doc.data()?.name || null;
          break;
        }
      } catch {}
    }

    if (!fbName) {
      console.log(`  ID ${oldId}: not in Firebase, ${songCount} songs orphaned — skipping`);
      continue;
    }

    const newId = nameToId.get(fbName.toUpperCase().trim());
    if (!newId) {
      console.log(`  ID ${oldId} (${fbName}): no matching program in DB — skipping ${songCount} songs`);
      continue;
    }

    const result = await client.query(`
      UPDATE songs
      SET praise_night_id = $1,
          raw_data = jsonb_set(COALESCE(raw_data,'{}'), '{praiseNightId}', to_jsonb($1::text), true)
      WHERE praise_night_id = $2
    `, [newId, oldId]);

    console.log(`  Fixed "${fbName}": ${oldId} -> ${newId} (${result.rowCount} songs)`);
    totalFixed += result.rowCount || 0;
  }

  // Verify
  const remaining = await client.query<{ count: string }>(`
    SELECT COUNT(*) as count FROM songs s
    WHERE s.praise_night_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.id = s.praise_night_id)
  `);
  console.log(`\n=== Done: ${totalFixed} songs fixed ===`);
  console.log(`Remaining orphaned songs: ${remaining.rows[0].count}`);

  client.release();
  await admin.app().delete();
  await pool.end();
}
main().catch(console.error);
