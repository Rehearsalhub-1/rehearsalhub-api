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

async function inspectAllFirestoreChatData() {
  const targetEmail = 'takeshopstores@gmail.com';
  console.log(`=== Inspecting Firestore for: ${targetEmail} ===\n`);

  // 1. Find user by email
  const usersSnap = await db.collection('users').where('email', '==', targetEmail).get();
  let targetUids: string[] = [];
  usersSnap.forEach(d => {
    console.log(`Found User Doc ID: ${d.id}, data:`, d.data().first_name, d.data().last_name, d.data().role);
    targetUids.push(d.id);
  });

  // Also check profiles collection
  const profilesSnap = await db.collection('profiles').where('email', '==', targetEmail).get();
  profilesSnap.forEach(d => {
    console.log(`Found Profile Doc ID: ${d.id}`);
    if (!targetUids.includes(d.id)) targetUids.push(d.id);
  });

  console.log(`\nTarget UIDs to search for:`, targetUids);

  // 2. List all root collections in Firestore
  const rootCollections = await db.listCollections();
  console.log(`\nRoot collections in Firestore (${rootCollections.length}):`);
  const colNames = rootCollections.map(c => c.id);
  console.log(colNames.join(', '));

  // 3. Inspect all chat-related collections
  const chatCollections = colNames.filter(name => 
    name.toLowerCase().includes('chat') || 
    name.toLowerCase().includes('message') || 
    name.toLowerCase().includes('group') ||
    name.toLowerCase().includes('channel') ||
    name.toLowerCase().includes('thread') ||
    name.toLowerCase().includes('conversation') ||
    name.toLowerCase().includes('archive')
  );

  console.log(`\nChat-related collections found:`, chatCollections);

  for (const colName of chatCollections) {
    const snap = await db.collection(colName).get();
    console.log(`\n--- Collection: "${colName}" (Total docs: ${snap.size}) ---`);
    
    // Check if any document mentions targetUids or targetEmail
    let matchedDocs = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const docStr = JSON.stringify(data);
      const docId = doc.id;
      const isTarget = targetUids.some(uid => docId.includes(uid) || docStr.includes(uid)) || docStr.includes(targetEmail);
      
      if (isTarget) {
        matchedDocs++;
        console.log(`  [Match ${matchedDocs}] Doc ID: ${docId}`);
        console.log(`    Fields:`, Object.keys(data));
        console.log(`    Name/Title:`, data.name || data.title || data.userName || data.subject);
        console.log(`    Participants:`, data.participants || data.members || data.memberIds);
        console.log(`    Type:`, data.type);
        console.log(`    Last Message:`, data.lastMessage || data.last_message);
      }
    }
    console.log(`  -> Total matches for target in "${colName}": ${matchedDocs}`);
  }

  // 4. Check subcollections on user docs (e.g. users/{uid}/chats, users/{uid}/archived_chats, etc.)
  for (const uid of targetUids) {
    const userDocRef = db.collection('users').doc(uid);
    const userSubCols = await userDocRef.listCollections();
    console.log(`\nSubcollections for user ${uid}:`, userSubCols.map(c => c.id));
    for (const subCol of userSubCols) {
      const subSnap = await subCol.get();
      console.log(`  Subcollection "${subCol.id}": ${subSnap.size} docs`);
      subSnap.forEach(d => {
        console.log(`    Sub Doc: ${d.id}`, d.data());
      });
    }
  }

  await admin.app().delete();
}

inspectAllFirestoreChatData().catch(console.error);
