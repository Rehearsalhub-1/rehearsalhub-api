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

async function fastSyncMessages() {
  console.log('=== 1. Loading all messages from Firestore ===');
  const existingUsers = await prisma.user.findMany({ select: { id: true } });
  const knownUserIds = new Set<string>(existingUsers.map(u => u.id));

  const existingChats = await prisma.chat.findMany({ select: { id: true } });
  const knownChatIds = new Set<string>(existingChats.map(c => c.id));

  const [m2Snap, mSnap, gmSnap] = await Promise.all([
    db.collection('messages_v2').get().catch(() => ({ docs: [] } as any)),
    db.collection('messages').get().catch(() => ({ docs: [] } as any)),
    db.collection('group_messages').get().catch(() => ({ docs: [] } as any)),
  ]);

  console.log(`Firestore message counts: messages_v2=${m2Snap.docs.length}, messages=${mSnap.docs.length}, group_messages=${gmSnap.docs.length}`);

  const messagesToUpsert: any[] = [];
  const usersToCreate: any[] = [];

  function ensureUser(uid: string, name?: string) {
    if (!uid || knownUserIds.has(uid)) return;
    knownUserIds.add(uid);
    usersToCreate.push({
      id: uid,
      email: `${uid.toLowerCase()}@placeholder.rehearsalhub.com`,
      firstName: name || 'Member',
      rawData: { id: uid, name: name || 'Member', role: 'member' },
    });
  }

  // Helper to normalize message
  function processMsgDoc(docId: string, data: any, defaultChatId?: string) {
    let chatId = data.chatId || data.chat_id || data.conversationId || data.conversation_id || data.groupId || data.group_id || defaultChatId;
    if (!chatId) return;

    if (chatId === 'yourloveworldsingers') chatId = 'group_zone_zone-001';
    else if (chatId === 'specialduty') chatId = 'group_zone_zone-088';
    else if (!knownChatIds.has(chatId) && !chatId.startsWith('group_')) {
      // Check if it matches a group
      if (knownChatIds.has(`group_${chatId}`)) chatId = `group_${chatId}`;
    }

    // If chat still not known, register it as direct or group chat
    if (!knownChatIds.has(chatId)) {
      knownChatIds.add(chatId);
    }

    const senderId = data.senderId || data.sender_id || data.userId || data.uid || 'system';
    ensureUser(senderId, data.senderName || data.sender_name);

    const msgType = String(data.type || 'TEXT').toUpperCase();
    const validTypes = ['TEXT', 'AUDIO', 'VIDEO', 'IMAGE', 'FILE'];
    const enumType = validTypes.includes(msgType) ? (msgType as any) : 'TEXT';

    messagesToUpsert.push({
      id: docId,
      chatId,
      senderId,
      text: data.text || data.content || data.message || '',
      type: enumType,
      status: data.status || 'delivered',
      reactions: data.reactions || {},
      rawData: data,
    });
  }

  for (const d of m2Snap.docs) processMsgDoc(d.id, d.data());
  for (const d of mSnap.docs) processMsgDoc(d.id, d.data());
  for (const d of gmSnap.docs) processMsgDoc(d.id, d.data());

  // Also read subcollections in chats_v2
  const chatsV2Snap = await db.collection('chats_v2').get().catch(() => ({ docs: [] } as any));
  for (const cDoc of chatsV2Snap.docs) {
    try {
      const subSnap = await cDoc.ref.collection('messages').get();
      subSnap.forEach(sDoc => processMsgDoc(sDoc.id, sDoc.data(), cDoc.id));
    } catch {}
  }

  if (usersToCreate.length > 0) {
    console.log(`Creating ${usersToCreate.length} missing user records...`);
    await prisma.user.createMany({ data: usersToCreate, skipDuplicates: true });
  }

  // Ensure all chat records exist before inserting messages
  const missingChats = Array.from(new Set(messagesToUpsert.map(m => m.chatId))).filter(cid => !existingChats.some(ec => ec.id === cid));
  if (missingChats.length > 0) {
    console.log(`Creating ${missingChats.length} placeholder chats for orphaned messages...`);
    for (const mcId of missingChats) {
      await prisma.chat.create({
        data: {
          id: mcId,
          type: mcId.startsWith('group_') ? 'GROUP' : 'DIRECT',
          createdById: 'system',
          rawData: { id: mcId },
        },
      }).catch(() => {});
    }
  }

  console.log(`Upserting ${messagesToUpsert.length} messages into PostgreSQL...`);
  await prisma.message.createMany({
    data: messagesToUpsert,
    skipDuplicates: true,
  });

  const totalMessages = await prisma.message.count();
  console.log(`Total messages in database: ${totalMessages}`);

  await prisma.$disconnect();
  await admin.app().delete();
}

fastSyncMessages().catch(console.error);
