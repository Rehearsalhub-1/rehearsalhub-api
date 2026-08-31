import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'loveworld-singers-app',
  });
}

const db = admin.firestore();

async function inspectChatCollections() {
  const targetUid = '8ILWjbl9IbgbuxBK9P23mB6pZBt1';
  console.log(`--- Inspecting All Target Chat Collections for UID: ${targetUid} ---\n`);

  const collections = [
    'chats',
    'chats_v2',
    'group_messages',
    'user_groups',
    'zone_admin_messages',
    'support_conversations',
    'support_messages',
    'messages',
    'messages_v2',
  ];

  for (const col of collections) {
    const snap = await db.collection(col).get();
    console.log(`\nCollection: "${col}" -> Total: ${snap.size}`);
    
    let matched = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const str = JSON.stringify(data);
      if (doc.id.includes(targetUid) || str.includes(targetUid)) {
        matched++;
        if (matched <= 5) {
          console.log(`  [Match ${matched}] Doc ID: ${doc.id}`);
          console.log(`    Data:`, JSON.stringify({
            name: data.name || data.title,
            type: data.type,
            participants: data.participants || data.members,
            lastMessage: data.lastMessage || data.last_message || data.text,
            createdAt: data.createdAt || data.created_at,
          }));
        }
      }
      
      // Also check subcollections for the first 3 docs
      if (col.includes('chat') && matched <= 2) {
        const subCols = await doc.ref.listCollections();
        if (subCols.length > 0) {
          console.log(`    Subcollections on ${doc.id}:`, subCols.map(s => s.id));
          for (const s of subCols) {
            const sSnap = await s.get();
            console.log(`      Subcollection ${s.id}: ${sSnap.size} docs`);
          }
        }
      }
    }
    console.log(`  -> Matched docs for user: ${matched} / ${snap.size}`);
  }

  await admin.app().delete();
}

inspectChatCollections().catch(console.error);
