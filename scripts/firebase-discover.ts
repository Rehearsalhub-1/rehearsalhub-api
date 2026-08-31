/**
 * Firebase Discovery Script
 * Lists all Firestore collections and document counts.
 * Run: npx tsx scripts/firebase-discover.ts
 */
import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'loveworld-singers-app',
});

const db = admin.firestore();

async function discoverCollections() {
  console.log('\n=== Firebase Firestore Collections ===\n');

  const collections = await db.listCollections();
  const results: { collection: string; count: number; sampleFields: string[] }[] = [];

  for (const col of collections) {
    const snapshot = await col.count().get();
    const count = snapshot.data().count;

    // Get one sample doc to see field names
    const sample = await col.limit(1).get();
    const sampleFields = sample.empty ? [] : Object.keys(sample.docs[0].data());

    results.push({ collection: col.id, count, sampleFields });
    console.log(`${col.id.padEnd(40)} ${String(count).padStart(6)} docs   fields: ${sampleFields.slice(0, 6).join(', ')}`);
  }

  console.log('\n=== Summary ===');
  console.log(`Total collections: ${results.length}`);
  console.log(`Total documents: ${results.reduce((s, r) => s + r.count, 0)}`);

  await admin.app().delete();
}

discoverCollections().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
