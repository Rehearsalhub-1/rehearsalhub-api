/**
 * Migrate Chats & Messages from Firebase to PostgreSQL via Prisma
 * Strict READ-ONLY on Firebase, Upsert in PostgreSQL.
 * Run: npx tsx scripts/migrate-chats-and-messages.ts
 */
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

function normalizeDate(val: any): Date {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  if (typeof val === 'object') {
    const sec = val._seconds ?? val.seconds;
    if (sec !== undefined) {
      const nano = val._nanoseconds ?? val.nanoseconds ?? 0;
      return new Date(sec * 1000 + Math.floor(nano / 1000000));
    }
    if (typeof val.toDate === 'function') return val.toDate();
  }
  if (typeof val === 'number') return new Date(val > 1e11 ? val : val * 1000);
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

async function migrateChatsAndMessages() {
  console.log('=== Starting Migration of Chats & Messages ===');

  // 1. Fetch all chats from Firebase
  const chatsSnap = await db.collection('chats').get();
  console.log(`Found ${chatsSnap.size} chats in Firebase.`);

  for (const doc of chatsSnap.docs) {
    const data = doc.data();
    const chatId = doc.id;
    const createdAt = normalizeDate(data.createdAt || data.created_at || data.timestamp);
    const createdById = data.createdBy || data.created_by || 'admin';
    const chatType = String(data.type || 'direct').toUpperCase() === 'GROUP' ? 'GROUP' : 'DIRECT';
    const orgId = data.zoneId || data.organizationId || null;

    // Ensure creator user exists in profiles or auth
    let creatorExists = await prisma.user.findUnique({ where: { id: createdById } });
    if (!creatorExists) {
      // Create stub user profile if not exists
      await prisma.user.create({
        data: {
          id: createdById,
          name: data.participantNames?.[createdById] || 'User',
          email: null,
        },
      }).catch(() => {});
    }

    // Upsert chat
    await prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        type: chatType as any,
        createdById,
        organizationId: orgId,
        createdAt,
        rawData: data,
      },
      update: {
        type: chatType as any,
        rawData: data,
      },
    });

    // Participants
    const participants: string[] = Array.isArray(data.participants)
      ? data.participants
      : Array.isArray(data.memberIds)
      ? data.memberIds
      : [createdById];

    for (const pId of participants) {
      if (!pId || typeof pId !== 'string') continue;
      // Ensure participant user exists
      const pUser = await prisma.user.findUnique({ where: { id: pId } });
      if (!pUser) {
        await prisma.user.create({
          data: {
            id: pId,
            name: data.participantNames?.[pId] || 'User',
          },
        }).catch(() => {});
      }

      await prisma.chatParticipant.upsert({
        where: { chatId_userId: { chatId, userId: pId } },
        create: {
          chatId,
          userId: pId,
          unreadCount: (data.unreadCount && typeof data.unreadCount[pId] === 'number') ? data.unreadCount[pId] : 0,
          joinedAt: createdAt,
        },
        update: {
          unreadCount: (data.unreadCount && typeof data.unreadCount[pId] === 'number') ? data.unreadCount[pId] : 0,
        },
      }).catch(err => console.warn(`Error adding participant ${pId} to chat ${chatId}:`, err.message));
    }
  }
  console.log('✓ All chats and participants migrated successfully.');

  // 2. Fetch all messages from messages_v2 and messages
  console.log('\n--- Migrating Messages ---');
  const collections = ['messages_v2', 'messages', 'support_messages'];
  let totalMigratedMessages = 0;

  for (const colName of collections) {
    const snap = await db.collection(colName).get();
    console.log(`Processing collection "${colName}" (${snap.size} docs)...`);

    for (const doc of snap.docs) {
      const data = doc.data();
      const msgId = doc.id;
      const chatId = data.chatId || data.chat_id;
      const senderId = data.senderId || data.sender_id || data.userId || 'admin';
      const text = data.text || data.content || data.message || '';
      const type = data.type || data.messageType || 'text';
      const edited = Boolean(data.edited);
      const status = data.status || 'read';
      const reactions = (data.reactions && typeof data.reactions === 'object') ? data.reactions : {};

      if (!chatId) continue;

      // Ensure chat exists
      const chatExists = await prisma.chat.findUnique({ where: { id: chatId } });
      if (!chatExists) {
        // Create parent chat if missing
        let senderExists = await prisma.user.findUnique({ where: { id: senderId } });
        if (!senderExists) {
          await prisma.user.create({
            data: { id: senderId, name: data.senderName || 'User' },
          }).catch(() => {});
        }

        await prisma.chat.create({
          data: {
            id: chatId,
            type: 'DIRECT',
            createdById: senderId,
            rawData: { id: chatId, name: 'Chat', participants: [senderId] },
          },
        }).catch(() => {});
      }

      // Ensure sender user exists
      let sender = await prisma.user.findUnique({ where: { id: senderId } });
      if (!sender) {
        await prisma.user.create({
          data: { id: senderId, name: data.senderName || 'User' },
        }).catch(() => {});
      }

      // Upsert message
      await prisma.message.upsert({
        where: { id: msgId },
        create: {
          id: msgId,
          chatId,
          senderId,
          text,
          type,
          edited,
          status,
          reactions,
          rawData: data,
        },
        update: {
          text,
          type,
          edited,
          status,
          reactions,
          rawData: data,
        },
      }).catch(err => console.warn(`Error inserting message ${msgId}:`, err.message));

      totalMigratedMessages++;
    }
  }

  console.log(`✓ Total migrated messages: ${totalMigratedMessages}`);

  const finalChats = await prisma.chat.count();
  const finalMessages = await prisma.message.count();
  console.log(`\nFinal PostgreSQL chats: ${finalChats}`);
  console.log(`Final PostgreSQL messages: ${finalMessages}`);

  await prisma.$disconnect();
}

migrateChatsAndMessages().catch(console.error);
