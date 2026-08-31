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

async function countAll() {
  console.log('--- Checking Firebase Collections Count ---');
  const collections = ['chats', 'messages', 'messages_v2', 'groups', 'user_groups', 'subgroups', 'song_history', 'support_messages', 'zone_admin_messages'];
  
  for (const c of collections) {
    try {
      const snap = await db.collection(c).count().get();
      console.log(`Firebase "${c}": ${snap.data().count} documents`);
    } catch (err: any) {
      console.log(`Firebase "${c}": error (${err.message})`);
    }
  }

  console.log('\n--- Checking PostgreSQL Count ---');
  const pgChats = await prisma.chat.count();
  const pgMessages = await prisma.message.count();
  const pgSubgroups = await prisma.subgroup.count();
  const pgSongHistory = await prisma.songHistory.count();

  console.log(`PostgreSQL chats: ${pgChats}`);
  console.log(`PostgreSQL messages: ${pgMessages}`);
  console.log(`PostgreSQL subgroups: ${pgSubgroups}`);
  console.log(`PostgreSQL song_history: ${pgSongHistory}`);

  await prisma.$disconnect();
}

countAll().catch(console.error);
