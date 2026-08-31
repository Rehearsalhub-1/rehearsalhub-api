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

async function fastSyncChats() {
  console.log('=== 1. Loading existing PostgreSQL data ===');
  const [existingUsers, existingOrgs] = await Promise.all([
    prisma.user.findMany({ select: { id: true } }),
    prisma.organization.findMany({ select: { id: true } }),
  ]);

  const knownUserIds = new Set<string>(existingUsers.map(u => u.id));
  const knownOrgIds = new Set<string>(existingOrgs.map(o => o.id));

  // Ensure default system user exists
  if (!knownUserIds.has('system')) {
    await prisma.user.create({
      data: {
        id: 'system',
        email: 'system@rehearsalhub.com',
        firstName: 'System',
        lastName: 'Admin',
        rawData: { role: 'hq_admin', name: 'System Admin' },
      },
    }).catch(() => {});
    knownUserIds.add('system');
  }

  console.log('\n=== 2. Loading Firestore collections ===');
  const [chatsV2Snap, chatsSnap, userGroupsSnap] = await Promise.all([
    db.collection('chats_v2').get().catch(() => ({ docs: [] } as any)),
    db.collection('chats').get().catch(() => ({ docs: [] } as any)),
    db.collection('user_groups').get().catch(() => ({ docs: [] } as any)),
  ]);

  console.log(`Loaded Firestore docs: chats_v2=${chatsV2Snap.docs.length}, chats=${chatsSnap.docs.length}, user_groups=${userGroupsSnap.docs.length}`);

  const allChatDocs = new Map<string, { id: string; data: any; source: string }>();

  // Process user_groups
  for (const doc of userGroupsSnap.docs) {
    const data = doc.data();
    const id = doc.id.startsWith('group_') ? doc.id : `group_${doc.id}`;
    allChatDocs.set(id, {
      id,
      data: {
        ...data,
        name: data.name || data.title || data.group_name || 'Group Chat',
        type: 'group',
        participants: data.members || data.participants || data.memberIds || (data.user_id ? [data.user_id] : []),
        createdBy: data.createdBy || data.created_by || data.user_id || 'system',
      },
      source: 'user_groups',
    });
  }

  // Process chats (legacy)
  for (const doc of chatsSnap.docs) {
    allChatDocs.set(doc.id, { id: doc.id, data: doc.data(), source: 'chats' });
  }

  // Process chats_v2 (highest precedence)
  for (const doc of chatsV2Snap.docs) {
    allChatDocs.set(doc.id, { id: doc.id, data: doc.data(), source: 'chats_v2' });
  }

  const usersToCreate: Array<{ id: string; email: string; firstName: string; rawData: any }> = [];
  const chatsToUpsert: any[] = [];
  const participantsToCreate: Array<{ chatId: string; userId: string; unreadCount: number }> = [];

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
    if (data.participantDetails && typeof data.participantDetails === 'object') {
      Object.keys(data.participantDetails).forEach(k => { if (k && k.length >= 20) pSet.add(k); });
    }
    if (data.participantNames && typeof data.participantNames === 'object') {
      Object.keys(data.participantNames).forEach(k => { if (k && k.length >= 20) pSet.add(k); });
    }
    if (chatId.includes('_') && !chatId.startsWith('group_')) {
      chatId.split('_').forEach(part => {
        if (part && part.length >= 20) pSet.add(part);
      });
    }

    let createdBy = String(data.createdBy || data.created_by || data.adminId || Array.from(pSet)[0] || 'system');
    pSet.add(createdBy);

    for (const uid of pSet) {
      if (!knownUserIds.has(uid)) {
        knownUserIds.add(uid);
        const pName = data.participantDetails?.[uid]?.name || data.participantNames?.[uid] || 'Member';
        usersToCreate.push({
          id: uid,
          email: `${uid.toLowerCase()}@placeholder.rehearsalhub.com`,
          firstName: pName,
          rawData: { id: uid, name: pName, role: 'member' },
        });
      }
    }

    let chatType: 'DIRECT' | 'GROUP' | 'ANNOUNCEMENT' = 'DIRECT';
    const rawType = String(data.type || '').toLowerCase();
    if (rawType.includes('group') || chatId.startsWith('group_') || (data.name && String(data.name).trim() !== '') || (data.title && String(data.title).trim() !== '') || pSet.size > 2) {
      chatType = 'GROUP';
    } else if (rawType.includes('announcement')) {
      chatType = 'ANNOUNCEMENT';
    }

    let organizationId: string | null = null;
    if (data.zoneId || data.zone_id || data.organizationId) {
      const zId = data.zoneId || data.zone_id || data.organizationId;
      if (knownOrgIds.has(zId)) organizationId = zId;
    } else if (chatId.includes('zone-')) {
      const match = chatId.match(/zone-[a-zA-Z0-9_-]+/);
      if (match && knownOrgIds.has(match[0])) organizationId = match[0];
    }

    let chatName = data.name || data.title || (data.rawData && (data.rawData.name || data.rawData.title));
    if (!chatName) {
      if (chatType === 'GROUP') {
        if (organizationId === 'zone-001' || chatId.includes('zone-001')) {
          chatName = 'Your Loveworld Singers';
        } else if (organizationId) {
          chatName = `Zone ${organizationId} Group`;
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

    chatsToUpsert.push({
      id: chatId,
      type: chatType,
      createdById: createdBy,
      organizationId,
      rawData,
      participants,
    });

    for (const pId of participants) {
      participantsToCreate.push({
        chatId,
        userId: pId,
        unreadCount: 0,
      });
    }
  }

  // 3. Batch create users
  if (usersToCreate.length > 0) {
    console.log(`\n=== 3. Creating ${usersToCreate.length} missing user records ===`);
    await prisma.user.createMany({
      data: usersToCreate,
      skipDuplicates: true,
    });
  }

  // 4. Upsert chats
  console.log(`\n=== 4. Upserting ${chatsToUpsert.length} chats ===`);
  for (const c of chatsToUpsert) {
    await prisma.chat.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        type: c.type,
        createdById: c.createdById,
        organizationId: c.organizationId,
        rawData: c.rawData,
      },
      update: {
        type: c.type,
        createdById: c.createdById,
        organizationId: c.organizationId,
        rawData: c.rawData,
      },
    });
  }

  // 5. Batch create participants
  console.log(`\n=== 5. Upserting ${participantsToCreate.length} chat participants ===`);
  await prisma.chatParticipant.createMany({
    data: participantsToCreate,
    skipDuplicates: true,
  });

  // 6. Verify totals
  const totalChats = await prisma.chat.count();
  const totalParticipants = await prisma.chatParticipant.count();
  const targetParticipants = await prisma.chatParticipant.count({
    where: { userId: '8ILWjbl9IbgbuxBK9P23mB6pZBt1' },
  });

  console.log(`\n=== SUCCESS! ===`);
  console.log(`Total Chats in Database: ${totalChats}`);
  console.log(`Total Chat Participants in Database: ${totalParticipants}`);
  console.log(`Target User Chat Enrollments: ${targetParticipants}`);

  await prisma.$disconnect();
  await admin.app().delete();
}

fastSyncChats().catch(console.error);
