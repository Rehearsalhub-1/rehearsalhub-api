import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';
import { broadcast, getUserPresence, getAllPresence } from '../ws/wsServer';

const router = Router();

// GET /chats/presence — get all online users presence map
router.get('/presence', requireAuth, async (_req, res) => {
  try {
    const presence = getAllPresence();
    return res.json({ data: presence });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch presence' });
  }
});

// GET /chats/presence/:userId — get single user presence
router.get('/presence/:userId', requireAuth, async (req, res) => {
  try {
    const presence = getUserPresence(req.params.userId);
    return res.json({ data: presence });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch presence' });
  }
});

function normalizeTimestampToISO(ts: any): string | null {
  if (!ts) return null;
  if (ts instanceof Date) {
    return !isNaN(ts.getTime()) ? ts.toISOString() : null;
  }
  if (typeof ts === 'object') {
    const sec = ts._seconds ?? ts.seconds;
    if (sec !== undefined && sec !== null) {
      const s = Number(sec);
      const nano = Number(ts._nanoseconds ?? ts.nanoseconds ?? 0);
      if (!isNaN(s)) {
        const d = new Date(s * 1000 + Math.floor(nano / 1000000));
        return !isNaN(d.getTime()) ? d.toISOString() : null;
      }
    }
    if (typeof ts.toDate === 'function') {
      const d = ts.toDate();
      if (d instanceof Date && !isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof ts.toMillis === 'function') {
      const d = new Date(ts.toMillis());
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  if (typeof ts === 'number') {
    const ms = ts > 1e11 ? ts : ts > 1e8 ? ts * 1000 : ts;
    const d = new Date(ms);
    return !isNaN(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof ts === 'string') {
    const num = Number(ts);
    if (!isNaN(num) && num > 1e8) {
      const ms = num > 1e11 ? num : num * 1000;
      const d = new Date(ms);
      return !isNaN(d.getTime()) ? d.toISOString() : null;
    }
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function shapeChat(row: any) {
  const merged = mergeRawRow(row);
  const raw = (row.rawData && typeof row.rawData === 'object') ? (row.rawData as Record<string, any>) : {};
  const participants = Array.isArray(merged.participants)
    ? merged.participants
    : Array.isArray(row.participants)
      ? row.participants
      : [];

  let lastMessageText = 'No messages yet';
  const lm = raw.lastMessage || raw.last_message || merged.lastMessage || merged.last_message;
  if (typeof lm === 'string') {
    lastMessageText = lm;
  } else if (lm && typeof lm === 'object' && typeof lm.text === 'string') {
    lastMessageText = lm.text;
  }

  const rawLastTimestamp = raw.lastTimestamp || raw.last_timestamp || raw.last_message_at || raw.updatedAt || raw.createdAt;
  let lastTimestamp = normalizeTimestampToISO(rawLastTimestamp);
  if (lm && typeof lm === 'object' && lm.timestamp) {
    const lmIso = normalizeTimestampToISO(lm.timestamp);
    if (lmIso) lastTimestamp = lmIso;
  }
  if (!lastTimestamp) {
    lastTimestamp = normalizeTimestampToISO(row.createdBy) || null;
  }

  const createdBy = String(row.createdBy || raw.createdBy || raw.created_by || '');

  return {
    ...merged,
    id: row.id,
    type: row.type ?? (merged.type as string | undefined) ?? 'direct',
    name: raw.name || raw.userName || raw.user_name || merged.name || 'Support Thread',
    createdBy,
    participants,
    memberIds: participants,
    participantDetails: (merged.participantDetails || row.participantDetails || {}) as Record<string, any>,
    unreadCount: merged.unreadCount || row.unreadCount || 0,
    lastMessage: lastMessageText,
    lastTimestamp,
  };
}

function chatParticipants(row: any): string[] {
  const raw = (row.rawData && typeof row.rawData === 'object') ? (row.rawData as Record<string, any>) : {};
  const participants = Array.isArray(row.participants)
    ? row.participants
    : Array.isArray(raw.participants)
      ? raw.participants
      : Array.isArray(raw.memberIds)
        ? raw.memberIds
        : [];
  return participants.map(String);
}

function canAccessChat(row: any, userId: string): boolean {
  return row.createdBy === userId || chatParticipants(row).includes(userId);
}

async function hydrateChats(chatRows: any[]) {
  if (!chatRows || chatRows.length === 0) return [];

  const allParticipantIds = new Set<string>();
  for (const row of chatRows) {
    const raw = (row.rawData && typeof row.rawData === 'object') ? (row.rawData as Record<string, any>) : {};
    const participants = Array.isArray(row.participants)
      ? row.participants
      : Array.isArray(raw.participants)
        ? raw.participants
        : Array.isArray(raw.memberIds)
          ? raw.memberIds
          : [];
    participants.forEach((id: any) => {
      if (id && typeof id === 'string') allParticipantIds.add(id);
    });
    if (row.createdBy) allParticipantIds.add(row.createdBy);
    if (raw.createdBy) allParticipantIds.add(raw.createdBy);
  }

  const profileMap = new Map<string, { name: string; avatar?: string; email?: string; username?: string }>();
  if (allParticipantIds.size > 0) {
    const idArray = Array.from(allParticipantIds);
    const pRows = await prisma.user.findMany({ where: { id: { in: idArray } } });
    for (const p of pRows) {
      const rawP = (p.rawData && typeof p.rawData === 'object') ? (p.rawData as Record<string, any>) : {};
      const firstName = p.firstName || rawP.first_name || rawP.firstName || '';
      const lastName = p.lastName || rawP.last_name || rawP.lastName || '';
      const fullName = `${firstName} ${lastName}`.trim() || rawP.name || rawP.full_name || rawP.displayName || p.email || 'Member';
      const avatar = p.avatarUrl || rawP.profile_image_url || rawP.avatar_url || rawP.photoURL || rawP.avatar;
      const username = (rawP.username || rawP.user_name || rawP.alias || '').replace(/^@/, '');
      profileMap.set(p.id, {
        name: fullName,
        avatar: avatar || undefined,
        email: p.email || undefined,
        username: username || undefined,
      });
    }
  }

  return chatRows.map((row) => {
    const shaped = shapeChat(row);
    const details: Record<string, any> = { ...(shaped.participantDetails || {}) };

    for (const pid of shaped.participants) {
      const prof = profileMap.get(pid);
      if (prof) {
        details[pid] = {
          name: prof.name,
          avatar: prof.avatar,
          email: prof.email,
          username: prof.username,
        };
      } else if (!details[pid] || details[pid].name === 'Member') {
        details[pid] = { name: 'Member' };
      }
    }

    if (shaped.createdBy && profileMap.has(shaped.createdBy)) {
      const creatorProf = profileMap.get(shaped.createdBy)!;
      details[shaped.createdBy] = {
        name: creatorProf.name,
        avatar: creatorProf.avatar,
        email: creatorProf.email,
        username: creatorProf.username,
      };
    }

    return {
      ...shaped,
      participantDetails: details,
    };
  });
}

// GET /chats — chats for user (or all chats for admin if ?all=true)
router.get('/', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const userId = auth.userId as string;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    const showAll = isHqAdmin && req.query.all === 'true';

    const allRows = await prisma.chat.findMany({
      include: { participants: true },
      take: 500,
    });

    let rows: any[] = [];
    if (showAll) {
      rows = allRows;
    } else {
      rows = allRows.filter((r) => {
        const raw = (r.rawData && typeof r.rawData === 'object') ? (r.rawData as Record<string, any>) : {};
        const pList = Array.isArray(r.participants)
          ? r.participants.map((p: any) => typeof p === 'string' ? p : p.userId)
          : Array.isArray(raw.participants)
            ? raw.participants
            : [];
        return (
          pList.includes(userId) ||
          r.createdById === userId ||
          raw.createdBy === userId ||
          raw.created_by === userId
        );
      });
    }

    const data = await hydrateChats(rows);
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[chats/]', err);
    res.status(500).json({ success: false, error: 'Failed to load chats' });
  }
});

// GET /chats/:chatId
router.get('/:chatId', requireAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const row = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!row) {
      res.status(404).json({ success: false, error: 'Chat not found' });
      return;
    }
    if (!canAccessChat(row, res.locals.auth.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    const [hydrated] = await hydrateChats([row]);
    res.json({ success: true, data: hydrated });
  } catch (err) {
    console.error('[chats/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load chat' });
  }
});

// POST /chats — Create new chat
router.post('/', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const { name, type = 'direct', member_ids = [], participants: inputParticipants, zone_id } = req.body;

    const rawList = Array.isArray(member_ids) && member_ids.length > 0
      ? member_ids
      : Array.isArray(inputParticipants)
        ? inputParticipants
        : [];

    const participants = rawList.includes(auth.userId)
      ? rawList
      : [...rawList, auth.userId];

    const requestedId = (req.body.id || req.body.chatId || (zone_id && type === 'group' ? `group_zone_${zone_id}` : null)) as string | null;
    const id = requestedId || crypto.randomUUID();
    const effectiveZoneId = zone_id || (req.tenant?.effectiveZoneId ?? null);

    const existing = await prisma.chat.findUnique({
      where: { id },
      include: { participants: true },
    });
    if (existing) {
      const prevParticipants = Array.isArray(existing.participants) ? (existing.participants as any[]).map(p => typeof p === 'string' ? p : p.userId) : [];
      const mergedParticipants = Array.from(new Set([...prevParticipants, ...participants]));
      const prevRaw = (existing.rawData && typeof existing.rawData === 'object') ? (existing.rawData as Record<string, any>) : {};

      const updated = await prisma.chat.update({
        where: { id },
        data: {
          rawData: {
            ...prevRaw,
            participants: mergedParticipants,
            zoneId: effectiveZoneId || prevRaw.zoneId,
            updatedAt: new Date().toISOString(),
          },
        },
        include: { participants: true },
      });

      for (const pId of mergedParticipants) {
        if (!prevParticipants.includes(pId)) {
          await prisma.chatParticipant.upsert({
            where: { chatId_userId: { chatId: id, userId: pId } },
            create: { chatId: id, userId: pId, unreadCount: 0 },
            update: {},
          });
        }
      }

      const [hydrated] = await hydrateChats([updated]);
      broadcast('chat', updated.id, hydrated);
      return res.status(200).json({ success: true, data: hydrated });
    }

    const now = new Date().toISOString();
    const rawData = {
      id,
      name,
      type,
      zoneId: effectiveZoneId,
      participants,
      createdBy: auth.userId,
      createdAt: now,
      updatedAt: now,
    };

    const chatType = String(type).toUpperCase() === 'GROUP' ? 'GROUP' : String(type).toUpperCase() === 'ANNOUNCEMENT' ? 'ANNOUNCEMENT' : 'DIRECT';

    const chat = await prisma.chat.create({
      data: {
        id,
        type: chatType as any,
        createdById: auth.userId,
        organizationId: effectiveZoneId || null,
        rawData,
        participants: {
          create: participants.map((pId: string) => ({
            userId: pId,
            unreadCount: 0,
          })),
        },
      },
      include: { participants: true },
    });

    const [hydrated] = await hydrateChats([chat]);
    broadcast('chat', chat.id, hydrated);
    res.status(201).json({ success: true, data: hydrated });
  } catch (err) {
    console.error('[chats:post]', err);
    res.status(500).json({ success: false, error: 'Failed to create chat' });
  }
});

// PATCH /chats/:chatId
router.patch('/:chatId', requireAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const existing = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Chat not found' });
      return;
    }
    if (!canAccessChat(existing, res.locals.auth.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const prevRaw = (existing.rawData && typeof existing.rawData === 'object')
      ? (existing.rawData as Record<string, any>)
      : {};

    const { 
      name, 
      avatar, 
      description, 
      admins, 
      pinnedMessageId, 
      pinnedBy,
      clearedAt,
      last_message, 
      lastMessage, 
      last_message_at, 
      member_ids, 
      participants 
    } = req.body;

    const nextParticipants = Array.isArray(member_ids)
      ? member_ids
      : Array.isArray(participants)
        ? participants
        : null;

    if ((Array.isArray(member_ids) || Array.isArray(participants) || admins !== undefined) && existing.createdById !== res.locals.auth.userId) {
      res.status(403).json({ success: false, error: 'Only the chat creator can change members or administrators' });
      return;
    }

    const nextRaw = {
      ...prevRaw,
      ...(name !== undefined ? { name } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(admins !== undefined ? { admins } : {}),
      ...(pinnedMessageId !== undefined ? { pinnedMessageId } : {}),
      ...(pinnedBy !== undefined ? { pinnedBy } : {}),
      ...(clearedAt !== undefined ? { clearedAt } : {}),
      ...(last_message !== undefined || lastMessage !== undefined ? { lastMessage: last_message || lastMessage } : {}),
      ...(last_message_at !== undefined ? { lastTimestamp: last_message_at } : {}),
      ...(nextParticipants ? { participants: nextParticipants } : {}),
      updatedAt: new Date().toISOString(),
    };

    const updated = await prisma.chat.update({
      where: { id: chatId },
      data: {
        rawData: nextRaw,
      },
      include: { participants: true },
    });

    if (nextParticipants && Array.isArray(nextParticipants)) {
      for (const pId of nextParticipants) {
        await prisma.chatParticipant.upsert({
          where: { chatId_userId: { chatId, userId: pId } },
          create: { chatId, userId: pId, unreadCount: 0 },
          update: {},
        });
      }
    }

    const [hydrated] = await hydrateChats([updated]);
    broadcast('chat', chatId, hydrated);
    res.json({ success: true, data: hydrated });
  } catch (err) {
    console.error('[chats:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update chat' });
  }
});

// DELETE /chats/:chatId — Delete chat / group
router.delete('/:chatId', requireAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) {
      res.status(404).json({ success: false, error: 'Chat not found' });
      return;
    }
    if (chat.createdById !== res.locals.auth.userId) {
      res.status(403).json({ success: false, error: 'Only the chat creator can delete this chat' });
      return;
    }
    await prisma.chatParticipant.deleteMany({ where: { chatId } });
    await prisma.message.deleteMany({ where: { chatId } });
    await prisma.chat.delete({ where: { id: chatId } });
    broadcast('chat_deleted', chatId, { id: chatId });
    res.json({ success: true, message: 'Chat deleted successfully' });
  } catch (err) {
    console.error('[chats:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete chat' });
  }
});

// DELETE /chats/:chatId/messages — Clear all messages in chat
router.delete('/:chatId/messages', requireAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat || !canAccessChat(chat, res.locals.auth.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    await prisma.message.deleteMany({ where: { chatId } });
    broadcast('chat_cleared', chatId, { chatId });
    res.json({ success: true, message: 'All messages cleared' });
  } catch (err) {
    console.error('[chats/:id/messages:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to clear messages' });
  }
});

// GET /chats/:chatId/messages
router.get('/:chatId/messages', requireAuth, async (req, res) => {
  try {
    const chat = await prisma.chat.findUnique({ where: { id: req.params.chatId } });
    if (!chat) {
      res.status(404).json({ success: false, error: 'Chat not found' });
      return;
    }
    if (!canAccessChat(chat, res.locals.auth.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    const messageRows = await prisma.message.findMany({ where: { chatId: req.params.chatId } });
    
    // Sort chronologically by createdAt from rawData
    messageRows.sort((a, b) => {
      const rawA = (a.rawData && typeof a.rawData === 'object') ? (a.rawData as Record<string, any>) : {};
      const rawB = (b.rawData && typeof b.rawData === 'object') ? (b.rawData as Record<string, any>) : {};
      const aIso = normalizeTimestampToISO(rawA.createdAt || rawA.timestamp || rawA.time || rawA.date);
      const bIso = normalizeTimestampToISO(rawB.createdAt || rawB.timestamp || rawB.time || rawB.date);
      const aTime = aIso ? new Date(aIso).getTime() : 0;
      const bTime = bIso ? new Date(bIso).getTime() : 0;
      return aTime - bTime;
    });

    const data = messageRows
      .filter((m) => {
        const raw = (m.rawData && typeof m.rawData === 'object') ? (m.rawData as Record<string, any>) : {};
        return !raw.deleted;
      })
      .map((m) => {
        const merged = mergeRawRow(m);
        const raw = (m.rawData && typeof m.rawData === 'object') ? (m.rawData as Record<string, any>) : {};
        const msgCreatedAt = normalizeTimestampToISO(raw.createdAt || raw.timestamp || raw.time || raw.date)
          || normalizeTimestampToISO((m as any).createdAt || (m as any).created_at)
          || '1970-01-01T00:00:00.000Z';
        return {
          ...merged,
          id: m.id,
          chatId: m.chatId,
          text: m.text ?? (merged.text as string | undefined) ?? (merged.content as string | undefined) ?? '',
          content: (merged.content as string | undefined) ?? m.text,
          type: m.type || raw.type || 'text',
          senderId: m.senderId || raw.senderId || 'admin',
          senderName: raw.senderName || raw.sender_name || 'Admin Support',
          senderAvatar: raw.senderAvatar || raw.sender_avatar,
          senderType: raw.senderType || (raw.senderId === 'admin' ? 'admin' : 'user'),
          timestamp: msgCreatedAt,
          createdAt: msgCreatedAt,
          updatedAt: normalizeTimestampToISO(raw.updatedAt) || msgCreatedAt,
          imageUrl: raw.imageUrl || raw.mediaUrl || raw.media_url,
          audioUrl: raw.audioUrl || raw.audio_url || raw.voiceUrl || raw.voice_url || raw.media_url,
          videoUrl: raw.videoUrl || raw.video_url,
          documentUrl: raw.documentUrl || raw.document_url,
          documentName: raw.documentName || raw.document_name,
          documentSize: raw.documentSize || raw.document_size,
          songData: raw.songData || raw.song_data,
          playlistData: raw.playlistData || raw.playlist_data,
          profileData: raw.profileData || raw.profile_data || raw.contactData || raw.contact_data,
          contactData: raw.contactData || raw.contact_data || raw.profileData,
          waveform: raw.waveform,
          duration: raw.duration || raw.voiceDuration || raw.voice_duration,
          pollOptions: raw.pollOptions || raw.poll_options,
          viewOnce: raw.viewOnce ?? false,
          viewOnceViewed: raw.viewOnceViewed ?? false,
          callType: raw.callType,
          callId: raw.callId,
          note: raw.note,
          attachment: raw.attachment,
          voiceUrl: raw.voiceUrl || raw.voice_url || raw.audioUrl,
          voiceDuration: raw.voiceDuration || raw.voice_duration || raw.duration,
          replyTo: raw.replyTo || raw.reply_to,
          reactions: m.reactions || raw.reactions || {},
          edited: m.edited ?? raw.edited ?? false,
          deleted: raw.deleted ?? false,
          starred: raw.starred ?? false,
          pinned: raw.pinned ?? raw.pinnedInChat ?? false,
          status: m.status || raw.status || 'delivered',
          pinnedInChat: raw.pinnedInChat ?? raw.pinned ?? false,
        };
      });

    // Mark unread messages from other senders as read & clear unread count for current user
    const auth = res.locals.auth;
    const chatId = req.params.chatId;
    const currentUserId = auth?.userId as string;
    if (currentUserId && chatId) {
      try {
        await prisma.chatParticipant.updateMany({
          where: { chatId, userId: currentUserId },
          data: { unreadCount: 0 },
        });

        await prisma.message.updateMany({
          where: {
            chatId,
            senderId: { not: currentUserId },
            status: { not: 'read' },
          },
          data: { status: 'read' },
        });
        broadcast('chat_read', chatId, { chatId, userId: currentUserId });
      } catch (readErr) {
        console.warn('[chats/:id/messages] Error clearing unread status:', readErr);
      }
    }

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[chats/:id/messages]', err);
    res.status(500).json({ success: false, error: 'Failed to load messages' });
  }
});

// POST /chats/:chatId/read — Explicitly mark chat as read
router.post('/:chatId/read', requireAuth, async (req: any, res) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;
    const currentUserId = auth.userId as string;

    const existingChat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!existingChat) {
      res.status(404).json({ success: false, error: 'Chat not found' });
      return;
    }
    if (!canAccessChat(existingChat, currentUserId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    await prisma.chatParticipant.updateMany({
      where: { chatId, userId: currentUserId },
      data: { unreadCount: 0 },
    });

    await prisma.message.updateMany({
      where: {
        chatId,
        senderId: { not: currentUserId },
      },
      data: { status: 'read' },
    });

    broadcast('chat_read', chatId, { chatId, userId: currentUserId });
    res.json({ success: true, message: 'Chat marked as read' });
  } catch (err) {
    console.error('[chats/:id/read]', err);
    res.status(500).json({ success: false, error: 'Failed to mark chat as read' });
  }
});

// PATCH /chats/messages/:messageId/status — Update delivery/read state.
router.patch('/messages/:messageId/status', requireAuth, async (req, res) => {
  try {
    const { messageId } = req.params;
    const status = req.body?.status;
    if (status !== 'delivered' && status !== 'read') {
      res.status(400).json({ success: false, error: 'Invalid message status' });
      return;
    }

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
      res.status(404).json({ success: false, error: 'Message not found' });
      return;
    }
    const chat = await prisma.chat.findUnique({ where: { id: message.chatId } });
    if (!chat || !canAccessChat(chat, res.locals.auth.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const recipientId = res.locals.auth.userId as string;
    const deviceId = String(req.body?.deviceId || req.headers['x-device-id'] || 'web').trim();
    if (!deviceId || deviceId.length > 200) {
      res.status(400).json({ success: false, error: 'Invalid device id' });
      return;
    }

    const raw = (message.rawData && typeof message.rawData === 'object') ? (message.rawData as Record<string, any>) : {};
    const receipts = { ...(raw.receipts || {}) };
    receipts[`${recipientId}:${deviceId}`] = { status, updatedAt: new Date().toISOString() };
    raw.receipts = receipts;

    await prisma.message.update({
      where: { id: messageId },
      data: { rawData: raw },
    });

    const receipt = { messageId, recipientId, deviceId, status, updatedAt: new Date().toISOString() };
    broadcast('message_receipt', message.chatId, receipt);
    res.json({ success: true, data: receipt });
  } catch (err) {
    console.error('[chats:message-status]', err);
    res.status(500).json({ success: false, error: 'Failed to update message status' });
  }
});

// POST /chats/:chatId/messages — Send message
router.post('/:chatId/messages', requireAuth, async (req: any, res) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) {
      res.status(404).json({ success: false, error: 'Chat not found' });
      return;
    }
    if (!canAccessChat(chat, auth.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    const text = req.body.text?.trim() || req.body.content?.trim() || '';
    if (!text && !req.body.imageUrl && !req.body.media_url && !req.body.mediaUrl && !req.body.attachment && !req.body.voiceUrl && !req.body.audioUrl && !req.body.songData && !req.body.playlistData && !req.body.profileData && !req.body.contactData) {
      res.status(400).json({ success: false, error: 'Message content is required' });
      return;
    }

    const requestedMessageId = typeof req.body.id === 'string' ? req.body.id.trim() : '';
    const id = requestedMessageId || crypto.randomUUID();
    if (id.length > 200) {
      res.status(400).json({ success: false, error: 'Message id is too long' });
      return;
    }
    const alreadyCreated = await prisma.message.findUnique({ where: { id } });
    if (alreadyCreated) {
      if (alreadyCreated.chatId !== chatId || alreadyCreated.senderId !== auth.userId) {
        res.status(409).json({ success: false, error: 'Message id is already in use' });
        return;
      }
      res.status(200).json({ success: true, data: alreadyCreated, duplicate: true });
      return;
    }
    const now = new Date().toISOString();
    const senderName = req.body.senderName || req.body.sender_name || 'User';
    const isSenderAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'zone_admin';

    const rawData = {
      id,
      chatId,
      text,
      content: text,
      type: req.body.type || 'text',
      senderId: auth.userId,
      senderName,
      senderAvatar: req.body.senderAvatar || req.body.sender_avatar,
      senderType: isSenderAdmin ? 'admin' : 'user',
      timestamp: now,
      createdAt: now,
      imageUrl: req.body.imageUrl || req.body.mediaUrl || req.body.media_url,
      mediaUrl: req.body.mediaUrl || req.body.media_url || req.body.imageUrl,
      audioUrl: req.body.audioUrl || req.body.audio_url || req.body.voiceUrl || req.body.voice_url || req.body.media_url,
      videoUrl: req.body.videoUrl || req.body.video_url,
      documentUrl: req.body.documentUrl || req.body.document_url,
      documentName: req.body.documentName || req.body.document_name,
      documentSize: req.body.documentSize || req.body.document_size,
      songData: req.body.songData || req.body.song_data,
      playlistData: req.body.playlistData || req.body.playlist_data,
      profileData: req.body.profileData || req.body.profile_data || req.body.contactData || req.body.contact_data,
      contactData: req.body.contactData || req.body.contact_data || req.body.profileData,
      waveform: req.body.waveform,
      duration: req.body.duration || req.body.voiceDuration || req.body.voice_duration,
      pollOptions: req.body.pollOptions || req.body.poll_options,
      viewOnce: req.body.viewOnce ?? false,
      viewOnceViewed: req.body.viewOnceViewed ?? false,
      callType: req.body.callType,
      callId: req.body.callId,
      note: req.body.note,
      attachment: req.body.attachment,
      voiceUrl: req.body.voiceUrl || req.body.voice_url || req.body.audioUrl,
      voiceDuration: req.body.voiceDuration || req.body.voice_duration || req.body.duration,
      replyTo: req.body.replyTo || req.body.reply_to,
      reactions: req.body.reactions || {},
      starred: req.body.starred ?? false,
      pinned: req.body.pinned ?? false,
      status: 'delivered',
    };

    await prisma.message.create({
      data: {
        id,
        chatId,
        senderId: auth.userId,
        text,
        type: (req.body.type ? String(req.body.type).toUpperCase() : 'TEXT') as any,
        reactions: req.body.reactions || {},
        rawData,
      },
    });

    // Update last message & increment unreadCount for other participants
    await prisma.chatParticipant.updateMany({
      where: {
        chatId,
        userId: { not: auth.userId },
      },
      data: {
        unreadCount: { increment: 1 },
      },
    });

    const existingChat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (existingChat) {
      const chatRaw = (existingChat.rawData && typeof existingChat.rawData === 'object') ? (existingChat.rawData as Record<string, any>) : {};
      await prisma.chat.update({
        where: { id: chatId },
        data: {
          rawData: { ...chatRaw, lastMessage: text || 'Media attachment', lastTimestamp: now, updatedAt: now },
        },
      });
    }

    broadcast('chat', chatId, rawData);
    broadcast('messages', chatId, rawData);
    res.status(201).json({ success: true, data: rawData });
  } catch (err) {
    console.error('[chats/:id/messages:post]', err);
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// POST /chats/:chatId/messages/:messageId/reactions — Toggle reaction
router.post('/:chatId/messages/:messageId/reactions', requireAuth, async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const { reaction } = req.body;
    const auth = res.locals.auth;
    const userId = auth.userId as string;

    const existing = await prisma.message.findUnique({ where: { id: messageId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Message not found' });
      return;
    }
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat || !canAccessChat(chat, userId) || existing.chatId !== chatId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const prevRaw = (existing.rawData && typeof existing.rawData === 'object')
      ? (existing.rawData as Record<string, any>)
      : {};

    const prevReactions: Record<string, string> = {
      ...((existing.reactions && typeof existing.reactions === 'object' ? existing.reactions : {}) as Record<string, string>),
      ...((prevRaw.reactions && typeof prevRaw.reactions === 'object' ? prevRaw.reactions : {}) as Record<string, string>),
    };

    if (!reaction || prevReactions[userId] === reaction) {
      delete prevReactions[userId];
    } else {
      prevReactions[userId] = reaction;
    }

    const nextRaw = {
      ...prevRaw,
      reactions: prevReactions,
      updatedAt: new Date().toISOString(),
    };

    await prisma.message.update({
      where: { id: messageId },
      data: {
        reactions: prevReactions,
        rawData: nextRaw,
      },
    });

    broadcast('message_reaction', chatId, { messageId, reactions: prevReactions });
    broadcast('messages', chatId, { id: messageId, reactions: prevReactions });
    res.json({ success: true, data: { messageId, reactions: prevReactions } });
  } catch (err) {
    console.error('[chats/:id/messages/:msgId/reactions]', err);
    res.status(500).json({ success: false, error: 'Failed to update reaction' });
  }
});

// PATCH /chats/:chatId/messages/:messageId — Edit or update message
router.patch('/:chatId/messages/:messageId', requireAuth, async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const { text, content, deleted, pinnedInChat, starred, pinned, viewOnceViewed, reactions } = req.body;
    const auth = res.locals.auth;
    const updateText = text !== undefined ? text : content;

    const existing = await prisma.message.findUnique({ where: { id: messageId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Message not found' });
      return;
    }
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat || existing.chatId !== chatId || !canAccessChat(chat, auth.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const prevRaw = (existing.rawData && typeof existing.rawData === 'object')
      ? (existing.rawData as Record<string, any>)
      : {};

    const nextRaw = {
      ...prevRaw,
      ...(updateText !== undefined ? { text: updateText, content: updateText, edited: true } : {}),
      ...(deleted !== undefined ? { deleted } : {}),
      ...(pinnedInChat !== undefined ? { pinnedInChat } : {}),
      ...(pinned !== undefined ? { pinned, pinnedInChat: pinned } : {}),
      ...(starred !== undefined ? { starred } : {}),
      ...(viewOnceViewed !== undefined ? { viewOnceViewed } : {}),
      ...(reactions !== undefined ? { reactions } : {}),
      updatedAt: new Date().toISOString(),
    };

    await prisma.message.update({
      where: { id: messageId },
      data: {
        ...(updateText !== undefined ? { text: updateText, edited: true } : {}),
        ...(reactions !== undefined ? { reactions } : {}),
        rawData: nextRaw,
      },
    });

    broadcast('message_updated', chatId, { id: messageId, ...nextRaw });
    broadcast('messages', chatId, { id: messageId, ...nextRaw });
    res.json({ success: true, data: { id: messageId, ...nextRaw } });
  } catch (err) {
    console.error('[chats/:id/messages/:msgId:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update message' });
  }
});

// DELETE /chats/:chatId/messages/:messageId — Delete message
router.delete('/:chatId/messages/:messageId', requireAuth, async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat || !canAccessChat(chat, res.locals.auth.userId)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    await prisma.message.delete({ where: { id: messageId } });
    broadcast('message_deleted', chatId, { messageId });
    broadcast('messages', chatId, { id: messageId, deleted: true });
    res.json({ success: true, message: 'Message deleted successfully' });
  } catch (err) {
    console.error('[chats/:id/messages/:msgId:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete message' });
  }
});

// POST /chats/:chatId/typing — Broadcast typing status
router.post('/:chatId/typing', requireAuth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { status, userName } = req.body;
    const auth = res.locals.auth;

    broadcast('typing', chatId, {
      chatId,
      userId: auth.userId,
      userName: userName || 'User',
      status: status || null,
      timestamp: Date.now(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[chats/:id/typing]', err);
    res.status(500).json({ success: false, error: 'Failed to broadcast typing status' });
  }
});

export default router;
