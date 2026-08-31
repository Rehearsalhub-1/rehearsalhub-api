import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import prisma from '../src/lib/prisma';

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'loveworld-singers-app',
  });
}

const db = admin.firestore();

async function inspectHistory() {
  console.log('--- Inspecting Song History in Firebase ---');
  const countSnap = await db.collection('song_history').count().get();
  console.log(`Total song_history docs in Firebase: ${countSnap.data().count}`);

  const sampleSnap = await db.collection('song_history').limit(10).get();
  sampleSnap.docs.forEach((doc, idx) => {
    console.log(`\n[${idx + 1}] ID: ${doc.id}`);
    console.log(JSON.stringify(doc.data(), null, 2));
  });

  // Check how many songs in PostgreSQL have history in rawData
  const postgresSongs = await prisma.song.findMany({
    select: { id: true, title: true, organizationId: true, programId: true, rawData: true },
  });
  let songsWithHistoryCount = 0;
  let totalHistoryEntriesInSongs = 0;
  for (const s of postgresSongs) {
    const raw = s.rawData as any;
    if (raw && Array.isArray(raw.history) && raw.history.length > 0) {
      songsWithHistoryCount++;
      totalHistoryEntriesInSongs += raw.history.length;
    }
  }
  console.log(`\nPostgres Songs with embedded history array: ${songsWithHistoryCount} (total ${totalHistoryEntriesInSongs} history entries)`);

  const pgHistoryCount = await prisma.songHistory.count();
  console.log(`Postgres song_history table count: ${pgHistoryCount}`);

  await prisma.$disconnect();
}

inspectHistory().catch(console.error);
