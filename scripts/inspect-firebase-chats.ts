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

async function inspectFirebase() {
  console.log('--- Inspecting Firebase Collections for Chats, Groups & History ---');
  const collections = await db.listCollections();
  console.log('All Collections:', collections.map(c => c.id));

  // Check for chat/group/message collections
  const targets = collections.filter(c => 
    c.id.toLowerCase().includes('chat') || 
    c.id.toLowerCase().includes('message') || 
    c.id.toLowerCase().includes('group') ||
    c.id.toLowerCase().includes('hist') ||
    c.id.toLowerCase().includes('subgroup')
  );

  for (const col of targets) {
    const snap = await col.limit(3).get();
    console.log(`\n========================================`);
    console.log(`Collection: "${col.id}" (${snap.size} sample docs)`);
    snap.docs.forEach(doc => {
      console.log(`\nDoc ID: ${doc.id}`);
      console.log('Data:', JSON.stringify(doc.data(), null, 2));
    });
  }
}

inspectFirebase().catch(console.error);
