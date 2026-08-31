import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import prisma from '../src/lib/prisma';

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

async function fastInspect() {
  const targetUid = '8ILWjbl9IbgbuxBK9P23mB6pZBt1';
  console.log('=== 1. Checking Firestore Chat Collections ===');

  for (const col of ['chats', 'chats_v2', 'user_groups', 'group_messages', 'support_conversations']) {
    const snap = await db.collection(col).limit(5).get();
    console.log(`\n--- Firestore Collection: ${col} (Sample of ${snap.size}) ---`);
    snap.forEach(d => {
      console.log(`Doc ID: ${d.id}`, JSON.stringify(d.data()).slice(0, 200));
    });
  }

  console.log('\n=== 2. Searching for Target User in Firestore "chats" and "chats_v2" ===');
  // Array contains participants
  try {
    const c1 = await db.collection('chats').where('participants', 'array-contains', targetUid).get();
    console.log(`Firestore 'chats' with targetUid in participants: ${c1.size}`);
    c1.forEach(d => console.log(`  [chats] ${d.id} =>`, d.data().name, d.data().type, d.data().participants));
  } catch (e: any) {
    console.log(`Error querying chats:`, e.message);
  }

  try {
    const c2 = await db.collection('chats_v2').where('participants', 'array-contains', targetUid).get();
    console.log(`Firestore 'chats_v2' with targetUid in participants: ${c2.size}`);
    c2.forEach(d => console.log(`  [chats_v2] ${d.id} =>`, d.data().name, d.data().type, d.data().participants));
  } catch (e: any) {
    console.log(`Error querying chats_v2:`, e.message);
  }

  console.log('\n=== 3. Checking PostgreSQL Chats & Participants ===');
  const pgChats = await prisma.chat.findMany({
    include: {
      participants: true,
    },
    take: 10,
  });

  console.log(`PostgreSQL Sample Chats (${pgChats.length}):`);
  pgChats.forEach(c => {
    console.log(`ID: ${c.id}, Type: ${c.type}, CreatedBy: ${c.createdById}, OrgId: ${c.organizationId}`);
    console.log(`  RawData Name: ${(c.rawData as any)?.name}, Participants:`, c.participants.map(p => p.userId));
  });

  const targetPgChats = await prisma.chatParticipant.findMany({
    where: { userId: targetUid },
    include: { chat: true },
  });
  console.log(`\nPostgreSQL Chats target user is participant in (${targetPgChats.length}):`);
  targetPgChats.forEach(p => {
    console.log(`Chat ID: ${p.chatId}, Type: ${p.chat.type}, RawData Name: ${(p.chat.rawData as any)?.name}`);
  });

  // Check how many total chats in PostgreSQL vs Firestore
  const totalPgChats = await prisma.chat.count();
  const totalPgParticipants = await prisma.chatParticipant.count();
  const totalPgMessages = await prisma.message.count();
  console.log(`\nTotals in PostgreSQL -> Chats: ${totalPgChats}, ChatParticipants: ${totalPgParticipants}, Messages: ${totalPgMessages}`);

  await prisma.$disconnect();
  await admin.app().delete();
}

fastInspect().catch(console.error);
