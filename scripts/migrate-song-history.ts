/**
 * Migrate Firebase song_history → PostgreSQL song_history
 *
 * Firebase song_id is the Firebase doc ID of the song, which was preserved
 * as the Prisma song.id during the main migration. So the join is direct:
 *   firebase.song_id → songs.id (Prisma cuid = Firebase doc ID)
 *
 * Docs with numeric song_id (legacy Supabase rows) are skipped.
 * Docs already in the DB are skipped (upsert by Firebase doc id).
 *
 * Run: npx tsx scripts/migrate-song-history.ts
 */

import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// ── Prisma ────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
  max: 5,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

// ── Firebase ──────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: 'loveworld-singers-app' });
const db = admin.firestore();

// ── Helpers ───────────────────────────────────────────────────────────────────
function toDate(val: any): Date | null {
  if (!val) return null;
  if (typeof val === 'object' && '_seconds' in val) return new Date(val._seconds * 1000);
  if (typeof val === 'object' && 'seconds' in val) return new Date(val.seconds * 1000);
  if (typeof val?.toDate === 'function') return val.toDate();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function str(val: any): string | null {
  if (val == null) return null;
  const s = String(val).trim();
  return s || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Migrating song_history from Firebase → PostgreSQL ===\n');

  // 1. Fetch all song IDs currently in the DB for fast existence check
  console.log('Loading existing song IDs from DB...');
  const dbSongs = await prisma.song.findMany({ select: { id: true } });
  const dbSongIds = new Set(dbSongs.map(s => s.id));
  console.log(`  ${dbSongIds.size} songs in DB`);

  // 2. Load all Firebase song_history docs in batches
  console.log('\nFetching song_history from Firebase...');
  let lastDoc: admin.firestore.QueryDocumentSnapshot | null = null;
  const BATCH_SIZE = 500;

  let inserted = 0;
  let skipped_no_song = 0;
  let skipped_legacy = 0;
  let skipped_exists = 0;
  let errors = 0;
  let totalFetched = 0;

  while (true) {
    let query = db.collection('song_history').orderBy('__name__').limit(BATCH_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    lastDoc = snap.docs[snap.docs.length - 1];
    totalFetched += snap.docs.length;
    process.stdout.write(`\r  Fetched ${totalFetched} docs...`);

    // Collect the Prisma upserts for this batch
    for (const doc of snap.docs) {
      const d = doc.data();
      const fbDocId = doc.id;

      // Use the doc's own 'id' field if present (some have it), else the doc ID
      const historyId = str(d.id) || fbDocId;

      // Skip legacy numeric song_ids (old Supabase migration artefacts)
      const rawSongId = str(d.song_id || d.songId);
      if (!rawSongId) { skipped_legacy++; continue; }
      if (/^\d+$/.test(rawSongId)) { skipped_legacy++; continue; }

      // Only insert if the song exists in our DB
      if (!dbSongIds.has(rawSongId)) { skipped_no_song++; continue; }

      const createdAt = toDate(d.created_at || d.createdAt) ?? new Date();
      const updatedAt = toDate(d.updated_at || d.updatedAt) ?? createdAt;

      try {
        await prisma.songHistory.upsert({
          where: { id: historyId },
          create: {
            id: historyId,
            songId: rawSongId,
            type: str(d.type) ?? 'metadata',
            title: str(d.title),
            newValue: str(d.new_value) ?? '',
            oldValue: str(d.old_value) ?? '',
            description: str(d.description),
            createdBy: str(d.created_by) ?? 'admin',
            createdAt,
            rawData: d,
          },
          update: {
            // Only update non-destructive fields; never overwrite existing content
            description: str(d.description),
            createdBy: str(d.created_by) ?? 'admin',
            rawData: d,
          },
        });
        inserted++;
      } catch (err: any) {
        errors++;
        if (errors <= 5) console.error(`\n  Error on ${historyId}:`, err.message);
      }
    }

    if (snap.docs.length < BATCH_SIZE) break;
  }

  console.log(`\n\n=== Done ===`);
  console.log(`  Total Firebase docs fetched:  ${totalFetched}`);
  console.log(`  Inserted / updated in DB:     ${inserted}`);
  console.log(`  Skipped (no matching song):   ${skipped_no_song}`);
  console.log(`  Skipped (legacy numeric id):  ${skipped_legacy}`);
  console.log(`  Errors:                       ${errors}`);

  // Final DB count
  const dbCount = await prisma.songHistory.count();
  console.log(`\n  song_history rows in DB now:  ${dbCount}`);

  await prisma.$disconnect();
  await pool.end();
  await admin.app().delete();
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
