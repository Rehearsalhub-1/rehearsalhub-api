/**
 * Complete Migration script for ALL Firebase Chats & Groups:
 * - chats (11 docs)
 * - chats_v2 (97 docs)
 * - user_groups (19 docs)
 * - messages_v2 (876 docs)
 * - messages (24 docs)
 * - group_messages (6 docs)
 * - support_messages (9 docs)
 * - zone_admin_messages (1 doc)
 * 
 * Strict READ-ONLY on Firebase. Upserts into PostgreSQL via Prisma.
 */
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

function normalizeTimestamp(val: any): Date {
  if (!val) return new Date();
  if (val instanceof Date) return isNaN(val.getTime()) ? new Date() : val;
  if (typeof val === 'object') {
    if (val._seconds !== undefined) return new Date(val._seconds * 1000);
    if (val.seconds !== undefined) return new Date(val.seconds * 1000);
    if (typeof val.toDate === 'function') return val.toDate();
  }
  if (typeof val === 'number') {
    return new Date(val > 1e11 ? val : val * 1000);
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

async function migrateAllChatsComplete() {
  console.log('=== Starting Complete Firebase Chats & Groups Migration ===\n');

  // Load existing valid users and organizations to satisfy foreign keys
  const [existingUsers, existingOrgs] = await Promise.all([
    prisma.user.findMany({ select: { id: true } }),
    prisma.organization.findMany({ select: { id: true } }),
  ]);
  const validUserIds = new Set(existingUsers.map(u => u.id));
  const validOrgIds = new Set(existingOrgs.map(o => o.id.toLowerCase()));

  console.log(`Valid users in DB: ${validUserIds.size}`);
  console.log(`Valid organizations in DB: ${validOrgIds.size}\n`);

  // Ensure default fallback user exists
  const fallbackUserId = 'admin';
  if (!validUserIds.has(fallbackUserId)) {
    await prisma.user.upsert({
      where: { id: fallbackUserId },
      update: {},
      create: {
        id: fallbackUserId,
        email: 'admin@loveworldsingers.org',
        role: 'HQ_ADMIN',
        firstName: 'HQ',
        lastName: 'Admin',
      },
    });
    validUserIds.add(fallbackUserId);
  }

  // 1. Collect all Chat rooms from chats, chats_v2, and user_groups
  const chatCollections = ['chats', 'chats_v2', 'user_groups'];
  const allChatDocs = new Map<string, { id: string; type: string; createdById: string; orgId: string | null; rawData: any; participants: Set<string> }>();

  for (const colName of chatCollections) {
    const snap = await db.collection(colName).get();
    console.log(`Fetched ${snap.size} documents from "${colName}"`);

    for (const doc of snap.docs) {
      const data = doc.data();
      const id = doc.id;
      const rawType = String(data.type || (colName === 'user_groups' ? 'group' : 'direct')).toLowerCase();
      const isGroup = rawType === 'group' || rawType === 'channel' || colName === 'user_groups' || id.startsWith('group_');
      const chatType = isGroup ? 'group' : 'direct';

      let createdById = data.createdBy || data.created_by || data.creatorId || data.adminId || fallbackUserId;
      if (!validUserIds.has(createdById)) {
        createdById = fallbackUserId;
      }

      let orgId = data.zoneId || data.organizationId || data.orgId || null;
      if (orgId && !validOrgIds.has(String(orgId).toLowerCase())) {
        orgId = null;
      }

      // Collect participants
      const pSet = new Set<string>();
      if (id.includes('_') && !id.startsWith('group_')) {
        id.split('_').forEach(part => {
          if (part && part.length >= 20 && !part.includes('-')) pSet.add(part);
        });
      } else if (id.length >= 20 && !id.includes('-') && !isGroup) {
        pSet.add(id);
      }

      if (Array.isArray(data.participants)) {
        data.participants.forEach((p: any) => {
          const uid = typeof p === 'string' ? p : (p.userId || p.id || p.uid);
          if (uid && typeof uid === 'string') pSet.add(uid);
        });
      }
      if (Array.isArray(data.members)) {
        data.members.forEach((m: any) => {
          const uid = typeof m === 'string' ? m : (m.userId || m.id || m.uid);
          if (uid && typeof uid === 'string') pSet.add(uid);
        });
      }
      if (Array.isArray(data.memberIds)) {
        data.memberIds.forEach((uid: any) => {
          if (uid && typeof uid === 'string') pSet.add(uid);
        });
      }

      if (data.createdBy && typeof data.createdBy === 'string') pSet.add(data.createdBy);

      const existing = allChatDocs.get(id);
      if (!existing) {
        allChatDocs.set(id, {
          id,
          type: chatType,
          createdById,
          orgId,
          rawData: { ...data, id, type: chatType, sourceCollection: colName },
          participants: pSet,
        });
      } else {
        // Merge participants and rawData
        pSet.forEach(p => existing.participants.add(p));
        existing.rawData = { ...existing.rawData, ...data, id, type: chatType };
      }
    }
  }

  console.log(`\nTotal unique Chat Rooms collected across all collections: ${allChatDocs.size}`);

  // 2. Ensure all referenced participant user IDs exist in PostgreSQL
  const allParticipantIds = new Set<string>();
  allChatDocs.forEach(c => c.participants.forEach(p => allParticipantIds.add(p)));

  for (const uid of allParticipantIds) {
    if (!validUserIds.has(uid)) {
      // Create lightweight user stub so foreign key succeeds
      try {
        await prisma.user.upsert({
          where: { id: uid },
          update: {},
          create: {
            id: uid,
            email: `user_${uid.slice(0, 8)}@singershub.local`,
            role: 'MEMBER',
            firstName: 'Singer',
            lastName: 'Member',
          },
        });
        validUserIds.add(uid);
      } catch (err) {
        // ignore
      }
    }
  }

  // 3. Upsert all Chats and ChatParticipants into PostgreSQL
  console.log(`Upserting ${allChatDocs.size} Chats into PostgreSQL...`);
  let upsertedChats = 0;
  for (const [id, chat] of allChatDocs.entries()) {
    const rawTime = chat.rawData.createdAt || chat.rawData.created_at || chat.rawData.timestamp;
    const createdAt = normalizeTimestamp(rawTime);

    await prisma.chat.upsert({
      where: { id },
      update: {
        type: chat.type,
        createdById: chat.createdById,
        organizationId: chat.orgId,
        rawData: chat.rawData,
      },
      create: {
        id,
        type: chat.type,
        createdById: chat.createdById,
        organizationId: chat.orgId,
        createdAt,
        rawData: chat.rawData,
      },
    });

    // Upsert participants
    for (const userId of chat.participants) {
      if (validUserIds.has(userId)) {
        await prisma.chatParticipant.upsert({
          where: {
            chatId_userId: {
              chatId: id,
              userId,
            },
          },
          update: {},
          create: {
            chatId: id,
            userId,
            unreadCount: 0,
            joinedAt: createdAt,
          },
        });
      }
    }
    upsertedChats++;
  }
  console.log(`Successfully migrated ${upsertedChats} chat rooms.\n`);

  // 4. Migrate Messages from messages_v2, messages, group_messages, support_messages, zone_admin_messages
  const messageCollections = [
    'messages_v2',
    'messages',
    'group_messages',
    'support_messages',
    'zone_admin_messages',
  ];

  let totalMessagesMigrated = 0;

  for (const colName of messageCollections) {
    const snap = await db.collection(colName).get();
    console.log(`Migrating ${snap.size} messages from "${colName}"...`);

    let count = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const id = doc.id;
      const chatId = data.chatId || data.ticketId || data.groupId || data.channelId || doc.ref.parent.parent?.id;

      if (!chatId) continue;

      // Ensure parent chat exists in PostgreSQL
      if (!allChatDocs.has(chatId)) {
        let senderId = data.senderId || data.sender_id || fallbackUserId;
        if (!validUserIds.has(senderId)) senderId = fallbackUserId;

        await prisma.chat.upsert({
          where: { id: chatId },
          update: {},
          create: {
            id: chatId,
            type: 'direct',
            createdById: senderId,
            createdAt: normalizeTimestamp(data.createdAt || data.timestamp),
            rawData: { id: chatId, autoCreatedForMessages: true },
          },
        });
        allChatDocs.set(chatId, { id: chatId, type: 'direct', createdById: senderId, orgId: null, rawData: {}, participants: new Set() });
      }

      let senderId = data.senderId || data.sender_id || fallbackUserId;
      if (!validUserIds.has(senderId)) {
        try {
          await prisma.user.upsert({
            where: { id: senderId },
            update: {},
            create: {
              id: senderId,
              email: `user_${senderId.slice(0, 8)}@singershub.local`,
              role: 'MEMBER',
              firstName: data.senderName?.split(' ')[0] || 'Singer',
              lastName: data.senderName?.split(' ')[1] || 'Member',
            },
          });
          validUserIds.add(senderId);
        } catch {
          senderId = fallbackUserId;
        }
      }

      const rawType = String(data.type || 'text').toUpperCase();
      const text = data.text || data.message || data.content || '';
      const createdAt = normalizeTimestamp(data.createdAt || data.timestamp);

      await prisma.message.upsert({
        where: { id },
        update: {
          chatId,
          senderId,
          text,
          type: rawType,
          edited: Boolean(data.edited),
          status: data.status || null,
          reactions: data.reactions || null,
          rawData: { ...data, id, chatId, senderId, text, type: rawType, createdAt: createdAt.toISOString() },
        },
        create: {
          id,
          chatId,
          senderId,
          text,
          type: rawType,
          edited: Boolean(data.edited),
          status: data.status || null,
          reactions: data.reactions || null,
          rawData: { ...data, id, chatId, senderId, text, type: rawType, createdAt: createdAt.toISOString() },
        },
      });

      count++;
    }
    console.log(`  -> Migrated ${count} messages from "${colName}"`);
    totalMessagesMigrated += count;
  }

  const finalChatCount = await prisma.chat.count();
  const finalMsgCount = await prisma.message.count();
  const finalParticipantCount = await prisma.chatParticipant.count();

  console.log('\n=== All Firebase Chats & Groups Migration Completed ===');
  console.log(`Total Chats in PostgreSQL: ${finalChatCount}`);
  console.log(`Total Messages in PostgreSQL: ${finalMsgCount}`);
  console.log(`Total Chat Participants in PostgreSQL: ${finalParticipantCount}`);

  await admin.app().delete();
}

migrateAllChatsComplete()
  .catch(err => {
    console.error('Migration error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
