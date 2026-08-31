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

async function migrateAllChatsAndMessages() {
  console.log('=== 1. Loading existing PostgreSQL users into memory cache ===');
  const existingUsers = await prisma.user.findMany({ select: { id: true } });
  const knownUserIds = new Set<string>(existingUsers.map(u => u.id));
  console.log(`Loaded ${knownUserIds.size} existing users from PostgreSQL`);

  const usersToCreate: Array<{ id: string; email: string; firstName: string; rawData: any }> = [];

  function registerUser(uid: string, name?: string) {
    if (!uid || uid.trim() === '' || knownUserIds.has(uid)) return;
    knownUserIds.add(uid);
    usersToCreate.push({
      id: uid,
      email: `${uid.toLowerCase()}@placeholder.rehearsalhub.com`,
      firstName: name || 'Member',
      rawData: { name: name || 'Member', id: uid, role: 'member' },
    });
  }

  console.log('\n=== 2. Loading all Firestore chat collections ===');
  const [chatsV2Snap, chatsSnap, userGroupsSnap] = await Promise.all([
    db.collection('chats_v2').get().catch(e => { console.warn('chats_v2 get err', e.message); return { docs: [] } as any; }),
    db.collection('chats').get().catch(e => { console.warn('chats get err', e.message); return { docs: [] } as any; }),
    db.collection('user_groups').get().catch(e => { console.warn('user_groups get err', e.message); return { docs: [] } as any; }),
  ]);

  console.log(`Firestore docs loaded: chats_v2=${chatsV2Snap.docs.length}, chats=${chatsSnap.docs.length}, user_groups=${userGroupsSnap.docs.length}`);

  const allChatDocs = new Map<string, { id: string; data: any; source: string }>();

  // Process user_groups as group chats
  for (const doc of userGroupsSnap.docs) {
    const data = doc.data();
    const id = doc.id.startsWith('group_') ? doc.id : `group_${doc.id}`;
    allChatDocs.set(id, {
      id,
      data: {
        ...data,
        name: data.name || data.title || 'Group Chat',
        type: 'group',
        participants: data.members || data.participants || data.memberIds || [],
        createdBy: data.createdBy || data.created_by || data.adminId,
      },
      source: 'user_groups',
    });
  }

  // Process chats (legacy)
  for (const doc of chatsSnap.docs) {
    const data = doc.data();
    allChatDocs.set(doc.id, { id: doc.id, data, source: 'chats' });
  }

  // Process chats_v2 (takes precedence)
  for (const doc of chatsV2Snap.docs) {
    const data = doc.data();
    allChatDocs.set(doc.id, { id: doc.id, data, source: 'chats_v2' });
  }

  // Collect all participant IDs
  const parsedChats: Array<{
    chatId: string;
    chatType: 'DIRECT' | 'GROUP' | 'ANNOUNCEMENT';
    createdBy: string;
    organizationId: string | null;
    chatName: string;
    participants: string[];
    rawData: any;
  }> = [];

  for (const [chatId, { data, source }] of allChatDocs.entries()) {
    const pSet = new Set<string>();
    if (Array.isArray(data.participants)) {
      data.participants.forEach((p: any) => { if (typeof p === 'string' && p.trim()) pSet.add(p.trim()); });
    }
    if (Array.isArray(data.memberIds)) {
      data.memberIds.forEach((p: any) => { if (typeof p === 'string' && p.trim()) pSet.add(p.trim()); });
    }
    if (Array.isArray(data.members)) {
      data.members.forEach((p: any) => { if (typeof p === 'string' && p.trim()) pSet.add(p.trim()); });
    }
    if (chatId.includes('_') && !chatId.startsWith('group_')) {
      chatId.split('_').forEach(part => {
        if (part && part.length >= 20) pSet.add(part);
      });
    }

    let createdBy = String(data.createdBy || data.created_by || data.adminId || Array.from(pSet)[0] || 'admin_placeholder');
    if (createdBy === 'admin_placeholder' && pSet.size > 0) {
      createdBy = Array.from(pSet)[0];
    }
    pSet.add(createdBy);

    for (const pId of pSet) {
      registerUser(pId);
    }

    let chatType: 'DIRECT' | 'GROUP' | 'ANNOUNCEMENT' = 'DIRECT';
    const rawType = String(data.type || '').toLowerCase();
    if (rawType.includes('group') || chatId.startsWith('group_') || data.name || data.title) {
      chatType = 'GROUP';
    } else if (rawType.includes('announcement')) {
      chatType = 'ANNOUNCEMENT';
    } else if (pSet.size > 2) {
      chatType = 'GROUP';
    }

    let organizationId: string | null = null;
    if (data.zoneId || data.zone_id || data.organizationId) {
      organizationId = data.zoneId || data.zone_id || data.organizationId;
    } else if (chatId.includes('zone-')) {
      const match = chatId.match(/zone-[a-zA-Z0-9_-]+/);
      if (match) organizationId = match[0];
    }

    let chatName = data.name || data.title || (data.rawData && (data.rawData.name || data.rawData.title));
    if (!chatName) {
      if (chatType === 'GROUP') {
        if (organizationId) {
          chatName = organizationId === 'zone-001' ? 'Your Loveworld Singers' : `Zone ${organizationId} Group`;
        } else {
          chatName = 'Group Chat';
        }
      }
    }

    const participants = Array.from(pSet);
    const rawData = {
      ...data,
      id: chatId,
      name: chatName,
      type: chatType.toLowerCase(),
      participants,
      createdBy,
      zoneId: organizationId,
      organizationId,
      migratedAt: new Date().toISOString(),
      migrationSource: source,
    };

    parsedChats.push({
      chatId,
      chatType,
      createdBy,
      organizationId,
      chatName,
      participants,
      rawData,
    });
  }

  // Insert any missing users in batch
  if (usersToCreate.length > 0) {
    console.log(`Creating ${usersToCreate.length} missing participant user records...`);
    for (const u of usersToCreate) {
      await prisma.user.create({ data: u }).catch(() => {});
    }
  }

  console.log(`\n=== 3. Upserting ${parsedChats.length} chats and participants ===`);
  for (const item of parsedChats) {
    await prisma.chat.upsert({
      where: { id: item.chatId },
      create: {
        id: item.chatId,
        type: item.chatType,
        createdById: item.createdBy,
        organizationId: item.organizationId,
        rawData: item.rawData,
      },
      update: {
        type: item.chatType,
        createdById: item.createdBy,
        organizationId: item.organizationId,
        rawData: item.rawData,
      },
    });

    for (const pId of item.participants) {
      await prisma.chatParticipant.upsert({
        where: { chatId_userId: { chatId: item.chatId, userId: pId } },
        create: {
          chatId: item.chatId,
          userId: pId,
          unreadCount: 0,
          joinedAt: new Date(),
        },
        update: {},
      });
    }
  }

  console.log('\n=== 4. Migrating top-level & subcollection messages ===');
  let messagesMigrated = 0;

  for (const colName of ['messages_v2', 'messages']) {
    try {
      const msgSnap = await db.collection(colName).get();
      console.log(`Loaded ${msgSnap.size} docs from "${colName}"`);
      for (const doc of msgSnap.docs) {
        const m = doc.data();
        const msgId = doc.id;
        const chatId = m.chatId || m.chat_id || m.conversationId || m.conversation_id;
        if (!chatId) continue;

        const senderId = m.senderId || m.sender_id || m.userId || m.uid || 'admin_placeholder';
        registerUser(senderId, m.senderName || m.sender_name);
        if (!knownUserIds.has(senderId)) {
          await prisma.user.create({
            data: {
              id: senderId,
              email: `${senderId.toLowerCase()}@placeholder.rehearsalhub.com`,
              firstName: m.senderName || m.sender_name || 'Member',
              rawData: { name: m.senderName || 'Member', id: senderId },
            },
          }).catch(() => {});
          knownUserIds.add(senderId);
        }

        const msgType = String(m.type || 'TEXT').toUpperCase();
        const validTypes = ['TEXT', 'AUDIO', 'VIDEO', 'IMAGE', 'FILE'];
        const enumType = validTypes.includes(msgType) ? (msgType as any) : 'TEXT';

        await prisma.message.upsert({
          where: { id: msgId },
          create: {
            id: msgId,
            chatId,
            senderId,
            text: m.text || m.content || m.message || '',
            type: enumType,
            status: m.status || 'delivered',
            reactions: m.reactions || {},
            rawData: m,
          },
          update: {
            chatId,
            senderId,
            text: m.text || m.content || m.message || '',
            type: enumType,
            reactions: m.reactions || {},
            rawData: m,
          },
        });
        messagesMigrated++;
      }
    } catch (e: any) {
      console.warn(`Error loading ${colName}:`, e.message);
    }
  }

  const finalChatsCount = await prisma.chat.count();
  const finalParticipantsCount = await prisma.chatParticipant.count();
  const finalMessagesCount = await prisma.message.count();

  console.log(`\n=== Migration Complete! ===`);
  console.log(`- Chats: ${finalChatsCount}`);
  console.log(`- ChatParticipants: ${finalParticipantsCount}`);
  console.log(`- Messages: ${finalMessagesCount}`);

  await prisma.$disconnect();
  await admin.app().delete();
}

migrateAllChatsAndMessages().catch(console.error);
