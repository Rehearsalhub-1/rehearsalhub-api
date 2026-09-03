import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function getUserDisplayName(u: any): string {
  if (!u) return 'Member';
  const first = (u.firstName || u.first_name || '').trim();
  const last = (u.lastName || u.last_name || '').trim();
  const full = [first, last].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (u.name && u.name !== 'Member' && u.name !== 'User') return u.name;
  if (u.displayName) return u.displayName;
  if (u.username) return u.username;
  if (u.email) {
    const emailPrefix = u.email.split('@')[0];
    if (emailPrefix) {
      return emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);
    }
  }
  if (u.phone) return u.phone;
  return 'Member';
}

function formatMessage(m: any) {
  const sender = m.sender || {};
  const senderName = getUserDisplayName(sender);

  let displayText = m.text || '';
  let playlistData = m.playlistData || null;
  let songData = m.songData || null;
  let profileData = m.profileData || m.contactData || null;
  let pollOptions = m.pollOptions || null;
  let audioUrl = m.audioUrl || m.mediaUrl || m.voiceUrl || null;
  let documentName = m.documentName || null;
  let documentSize = m.documentSize || null;
  let replyTo = m.replyTo || null;

  if (typeof m.text === 'string' && m.text.startsWith('{') && m.text.endsWith('}')) {
    try {
      const parsed = JSON.parse(m.text);
      if (parsed && typeof parsed === 'object') {
        displayText = parsed.text || '';
        playlistData = parsed.playlistData || playlistData;
        songData = parsed.songData || songData;
        profileData = parsed.profileData || parsed.contactData || profileData;
        pollOptions = parsed.pollOptions || pollOptions;
        audioUrl = parsed.audioUrl || parsed.mediaUrl || parsed.voiceUrl || audioUrl;
        documentName = parsed.documentName || documentName;
        documentSize = parsed.documentSize || documentSize;
        replyTo = parsed.replyTo || replyTo;
      }
    } catch {}
  }

  // Fallback text parsers if structured payload was legacy formatted text
  if (m.type === 'playlist_share' && !playlistData && typeof displayText === 'string') {
    const nameMatch = displayText.match(/💽\s*\*Playlist:\s*([^*]+)\*/i);
    const countMatch = displayText.match(/(\d+)\s+songs/i);
    const idMatch = displayText.match(/playlist\/([a-zA-Z0-9_-]+)/i);
    if (nameMatch) {
      playlistData = {
        id: idMatch ? idMatch[1] : 'favs',
        name: nameMatch[1].trim(),
        songCount: countMatch ? parseInt(countMatch[1]) : 0,
        songs: [],
      };
    }
  }

  if (m.type === 'song_share' && !songData && typeof displayText === 'string') {
    const titleMatch = displayText.match(/🎵\s*\*([^*]+)\*/i);
    const idMatch = displayText.match(/song\/([a-zA-Z0-9_-]+)/i);
    const singerMatch = displayText.match(/👤\s*([^\n\r]+)/i);
    if (titleMatch) {
      songData = {
        id: idMatch ? idMatch[1] : 'song_1',
        title: titleMatch[1].trim(),
        leadSinger: singerMatch ? singerMatch[1].trim() : 'Singer',
      };
    }
  }

  return {
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    senderName,
    sender: senderName,
    senderAvatar: sender.avatarUrl || sender.avatar || null,
    text: displayText,
    type: m.type || 'text',
    playlistData,
    songData,
    profileData,
    contactData: profileData,
    pollOptions,
    audioUrl,
    mediaUrl: audioUrl,
    voiceUrl: audioUrl,
    documentName,
    documentSize,
    replyTo,
    status: m.status || 'sent',
    edited: m.edited || false,
    createdAt: m.createdAt,
  };
}

function formatChat(c: any, currentUserId?: string, extraUsersMap: Record<string, any> = {}) {
  const participants: string[] = [];
  const details: Record<string, any> = {};

  if (Array.isArray(c.participants)) {
    for (const p of c.participants) {
      const u = p.user || extraUsersMap[p.userId] || p;
      const uid = p.userId || u.id;
      if (uid) {
        if (!participants.includes(uid)) participants.push(uid);
        const name = getUserDisplayName(u);
        details[uid] = {
          id: uid,
          name,
          avatar: u.avatarUrl || u.avatar || null,
          email: u.email || null,
          firstName: u.firstName || u.first_name || null,
          lastName: u.lastName || u.last_name || null,
        };
      }
    }
  }

  // Extract from composite ID (e.g. uid1_uid2) ONLY for legacy direct chats when DB participants is empty
  if (participants.length === 0 && (c.type === 'direct' || !c.type) && typeof c.id === 'string' && c.id.includes('_') && !c.id.startsWith('group_') && !c.id.startsWith('chat_')) {
    const parts = c.id.split('_');
    if (parts.length === 2) {
      for (const uid of parts) {
        if (uid && !participants.includes(uid)) {
          participants.push(uid);
          const u = extraUsersMap[uid];
          const name = getUserDisplayName(u);
          details[uid] = {
            id: uid,
            name,
            avatar: u?.avatarUrl || u?.avatar || null,
            email: u?.email || null,
            firstName: u?.firstName || u?.first_name || null,
            lastName: u?.lastName || u?.last_name || null,
          };
        }
      }
    }
  }

  const lastMsg = Array.isArray(c.messages) && c.messages.length > 0 ? c.messages[0] : null;
  const lastSender = lastMsg?.sender || (lastMsg?.senderId ? extraUsersMap[lastMsg.senderId] || details[lastMsg.senderId] : null);
  const lastSenderName = getUserDisplayName(lastSender);

  let lastMsgText = lastMsg?.text || '';
  if (typeof lastMsgText === 'string' && lastMsgText.startsWith('{') && lastMsgText.endsWith('}')) {
    try {
      const parsed = JSON.parse(lastMsgText);
      lastMsgText = parsed.text || lastMsgText;
    } catch {}
  }

  const isDirect = (c.type || '').toLowerCase() === 'direct' || (!c.type && participants.length <= 2);
  let title = c.title || (isDirect ? 'Direct Message' : 'Group Chat');
  let avatar = c.avatar ? (typeof c.avatar === 'string' ? { uri: c.avatar } : c.avatar) : null;

  // For direct chats, resolve the other participant's actual name and avatar
  if (isDirect && currentUserId) {
    const otherId = participants.find(id => id !== currentUserId) || participants[0];
    if (otherId && details[otherId]?.name && details[otherId].name !== 'Member') {
      title = details[otherId].name;
      if (details[otherId].avatar) {
        avatar = { uri: details[otherId].avatar };
      }
    } else if (otherId && extraUsersMap[otherId]?.firstName) {
      title = getUserDisplayName(extraUsersMap[otherId]);
      if (extraUsersMap[otherId]?.avatarUrl) {
        avatar = { uri: extraUsersMap[otherId].avatarUrl };
      }
    }
  }

  const myParticipant = Array.isArray(c.participants) ? c.participants.find((p: any) => (p.userId || p.id) === currentUserId) : null;
  const myUnreadCount = typeof myParticipant?.unreadCount === 'number' ? myParticipant.unreadCount : 0;

  const unreadMap: Record<string, number> = {};
  if (Array.isArray(c.participants)) {
    for (const p of c.participants) {
      if (p.userId) unreadMap[p.userId] = p.unreadCount || 0;
    }
  }

  return {
    id: c.id,
    title,
    name: title,
    type: isDirect ? 'direct' : 'group',
    isGroup: !isDirect,
    category: isDirect ? 'Direct' : 'Groups',
    avatar: avatar?.uri || (typeof avatar === 'string' ? avatar : null),
    organizationId: c.organizationId || null,
    createdById: c.createdById,
    participants,
    participantDetails: details,
    lastMessage: lastMsg ? {
      text: lastMsgText,
      senderId: lastMsg.senderId,
      senderName: lastSenderName,
      timestamp: lastMsg.createdAt,
      status: lastMsg.status || 'sent',
    } : null,
    lastMessageSenderId: lastMsg?.senderId || null,
    lastMessageSenderName: lastSenderName,
    lastTimestamp: lastMsg?.createdAt || c.createdAt,
    unreadCount: myUnreadCount,
    unread: myUnreadCount,
    unreadMap,
    createdAt: c.createdAt,
  };
}

// 1. GET /chats — List chats for authenticated user (Strict Channel Isolation)
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;

    const chatRows = await prisma.chat.findMany({
      where: {
        participants: { some: { userId } },
      },
      include: {
        participants: {
          include: { user: true },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // Collect any participant IDs that might not have a joined user relation
    const missingUserIds = new Set<string>();
    chatRows.forEach((c) => {
      if (c.id.includes('_')) {
        c.id.split('_').forEach((id) => {
          if (!c.participants.some((p) => p.userId === id)) missingUserIds.add(id);
        });
      }
      c.messages.forEach((m) => {
        if (m.senderId && !c.participants.some((p) => p.userId === m.senderId)) missingUserIds.add(m.senderId);
      });
    });

    const extraUsersMap: Record<string, any> = {};
    if (missingUserIds.size > 0) {
      const extraUsers = await prisma.user.findMany({
        where: { id: { in: Array.from(missingUserIds) } },
      });
      extraUsers.forEach((u) => { extraUsersMap[u.id] = u; });
    }

    const data = chatRows.map((c) => formatChat(c, userId, extraUsersMap));
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[chats:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load chats' });
  }
});

// 2. GET /chats/:chatId — Get single chat
router.get('/:chatId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const userId = res.locals.auth.userId as string;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: {
          include: { user: true },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: true },
        },
      },
    });

    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });
    const isParticipant = chat.participants.some((p) => p.userId === userId) || chat.id.includes(userId) || chat.createdById === userId;
    if (!isParticipant) return res.status(403).json({ success: false, error: 'Forbidden' });

    res.json({ success: true, data: formatChat(chat, userId) });
  } catch (err) {
    console.error('[chats:get:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load chat' });
  }
});

// 3. POST /chats — Create or find direct / group chat
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { type = 'direct', title, name, memberIds = [], participants = [], organizationId, zoneId } = req.body;
    const rawParticipants = Array.from(new Set([...memberIds, ...participants, auth.userId]));
    const isDirectType = (type || '').toLowerCase() === 'direct';
    const chatTitle = title || name || (isDirectType ? 'Direct Message' : 'Group Chat');
    const orgId = organizationId || zoneId || req.tenant?.effectiveZoneId || null;

    // Respect client-requested ID if provided (e.g. from NewChatScreen)
    const requestedId = (req.body.id && typeof req.body.id === 'string' && req.body.id.trim()) ? req.body.id.trim() : null;
    const sorted = [...rawParticipants].sort();
    const chatId = requestedId || (isDirectType && sorted.length === 2
      ? `${sorted[0]}_${sorted[1]}`
      : `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

    // Check if chat already exists by ID or direct participants
    const existing = await prisma.chat.findFirst({
      where: {
        OR: [
          { id: chatId },
          ...(isDirectType && sorted.length === 2 ? [
            { id: `${sorted[1]}_${sorted[0]}` },
            {
              AND: [
                { participants: { some: { userId: sorted[0] } } },
                { participants: { some: { userId: sorted[1] } } },
              ],
            },
          ] : []),
        ],
      },
      include: {
        participants: { include: { user: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, include: { sender: true } },
      },
    });

    if (existing) {
      return res.json({ success: true, data: formatChat(existing, auth.userId) });
    }

    const newChat = await prisma.chat.create({
      data: {
        id: chatId,
        type: isDirectType ? 'direct' : 'group',
        title: chatTitle,
        createdById: auth.userId,
        organizationId: orgId,
        participants: {
          create: rawParticipants.map((uId: string) => ({
            userId: uId,
          })),
        },
      },
      include: {
        participants: { include: { user: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, include: { sender: true } },
      },
    });

    const formatted = formatChat(newChat, auth.userId);
    broadcast('chat', chatId, formatted);
    rawParticipants.forEach((uId: string) => {
      broadcast('chats', uId, { type: 'chat_created', chat: formatted });
    });
    res.status(201).json({ success: true, data: formatted });
  } catch (err) {
    console.error('[chats:create]', err);
    res.status(500).json({ success: false, error: 'Failed to create chat' });
  }
});

// 4. GET /chats/:chatId/messages — Get chat messages
router.get('/:chatId/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const userId = res.locals.auth.userId as string;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });
    const isParticipant = chat.participants.some((p) => p.userId === userId);
    if (!isParticipant) return res.status(403).json({ success: false, error: 'Forbidden' });

    const messages = await prisma.message.findMany({
      where: { chatId },
      include: { sender: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    res.json({ success: true, count: messages.length, data: messages.map(formatMessage) });
  } catch (err) {
    console.error('[chats:messages:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load messages' });
  }
});

// 5. POST /chats/:chatId/messages — Send message
router.post('/:chatId/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;
    const text = (req.body.text || req.body.content || req.body.message || '').trim();
    const type = req.body.type || 'text';

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });
    const isParticipant = chat.participants.some((p) => p.userId === auth.userId);
    if (!isParticipant) return res.status(403).json({ success: false, error: 'Forbidden' });

    // 1. Direct chat block check
    if (chat.type === 'direct') {
      const recipient = chat.participants.find(p => p.userId !== auth.userId);
      if (recipient) {
        const blockKey = `blocked_users_${recipient.userId}`;
        const blockSetting = await prisma.setting.findUnique({ where: { key: blockKey } });
        const blockedList: string[] = Array.isArray(blockSetting?.value) ? (blockSetting?.value as string[]) : [];
        if (blockedList.includes(auth.userId)) {
          return res.status(403).json({ success: false, error: 'Cannot send message to this user' });
        }
      }
    }

    // 2. Group adminOnlySend check
    if (chat.type === 'group') {
      const settingsKey = `chat_settings_${chatId}`;
      const settingsRow = await prisma.setting.findUnique({ where: { key: settingsKey } });
      const groupSettings: any = settingsRow?.value || {};
      if (groupSettings.adminOnlySend) {
        const isCreator = chat.createdById === auth.userId;
        const roleKey = `chat_role_${chatId}_${auth.userId}`;
        const roleRow = await prisma.setting.findUnique({ where: { key: roleKey } });
        const isGroupAdmin = roleRow?.value && typeof roleRow.value === 'object' && (roleRow.value as any).role === 'admin';
        if (!isCreator && !isGroupAdmin && auth.role !== 'admin' && auth.role !== 'hq_admin') {
          return res.status(403).json({ success: false, error: 'Only admins can send messages in this group' });
        }
      }
    }

    const messageId = req.body.id || crypto.randomUUID();

    let storedText = text;
    const hasStructuredData = req.body.playlistData || req.body.songData || req.body.profileData || req.body.contactData || req.body.pollOptions || req.body.media_url || req.body.audioUrl || req.body.voiceUrl || req.body.documentName;

    if (hasStructuredData) {
      storedText = JSON.stringify({
        text,
        playlistData: req.body.playlistData || null,
        songData: req.body.songData || null,
        profileData: req.body.profileData || req.body.contactData || null,
        contactData: req.body.contactData || req.body.profileData || null,
        pollOptions: req.body.pollOptions || null,
        audioUrl: req.body.audioUrl || req.body.media_url || req.body.voiceUrl || null,
        mediaUrl: req.body.media_url || req.body.audioUrl || null,
        voiceUrl: req.body.voiceUrl || req.body.audioUrl || null,
        documentName: req.body.documentName || null,
        documentSize: req.body.documentSize || null,
        replyTo: req.body.replyTo || null,
      });
    }

    const message = await prisma.message.create({
      data: {
        id: messageId,
        chatId,
        senderId: auth.userId,
        text: storedText,
        type,
        status: 'sent',
      },
      include: { sender: true },
    });

    // Increment unread count for other participants
    await prisma.chatParticipant.updateMany({
      where: {
        chatId,
        userId: { not: auth.userId },
      },
      data: {
        unreadCount: { increment: 1 },
      },
    });

    // Touch chat updatedAt so it immediately floats to the top of the chat list
    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    }).catch(() => {});

    const formatted = formatMessage(message);
    broadcast('chat', chatId, formatted);
    broadcast('messages', chatId, formatted);

    // Broadcast to each participant's user channel to instantly update their chat list
    chat.participants.forEach((p) => {
      broadcast('chats', p.userId, { type: 'chat_updated', chatId, lastMessage: formatted });
    });
    res.status(201).json({ success: true, data: formatted });
  } catch (err) {
    console.error('[chats:messages:send]', err);
    res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// 6. PATCH /chats/:chatId/messages/:messageId — Edit message
router.patch('/:chatId/messages/:messageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId, messageId } = req.params;
    const { text, content } = req.body;
    const auth = res.locals.auth;

    const existing = await prisma.message.findUnique({ where: { id: messageId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Message not found' });
    if (existing.senderId !== auth.userId) return res.status(403).json({ success: false, error: 'Forbidden' });

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        text: text !== undefined ? text : content,
        edited: true,
      },
      include: { sender: true },
    });

    const formatted = formatMessage(updated);
    broadcast('message_updated', chatId, formatted);
    broadcast('messages', chatId, formatted);
    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[chats:messages:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to edit message' });
  }
});

// DELETE /chats/:chatId/messages — Clear messages in chat
router.delete('/:chatId/messages', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    await prisma.message.deleteMany({
      where: { chatId },
    });

    broadcast('chat_cleared', chatId, { chatId, clearedBy: auth.userId });
    res.json({ success: true, message: 'Chat messages cleared' });
  } catch (err: any) {
    console.error('[chats:messages:clear]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to clear chat' });
  }
});

// 7. DELETE /chats/:chatId/messages/:messageId — Delete message
router.delete('/:chatId/messages/:messageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId, messageId } = req.params;
    const auth = res.locals.auth;

    const existing = await prisma.message.findUnique({ where: { id: messageId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Message not found' });
    if (existing.senderId !== auth.userId) return res.status(403).json({ success: false, error: 'Forbidden' });

    await prisma.message.delete({ where: { id: messageId } });
    broadcast('message_deleted', chatId, { messageId });
    broadcast('messages', chatId, { id: messageId, deleted: true });
    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    console.error('[chats:messages:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete message' });
  }
});

// 8. POST /chats/:chatId/typing — Broadcast typing status
router.post('/:chatId/typing', requireAuth, async (req: Request, res: Response) => {
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
    console.error('[chats:typing]', err);
    res.status(500).json({ success: false, error: 'Failed to broadcast typing status' });
  }
});

// In-memory presence map for high-frequency heartbeat updates
const userPresenceMap = new Map<string, { isOnline: boolean; lastSeen: number }>();

// 9. GET /chats/presence/:userId — User presence status
router.get('/presence/:userId', requireAuth, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const presence = userPresenceMap.get(userId) || { isOnline: false, lastSeen: Date.now() - 300000 };
  res.json({ success: true, data: presence });
});

// 10. POST /chats/presence — Heartbeat presence update
router.post('/presence', requireAuth, async (req: Request, res: Response) => {
  const auth = res.locals.auth;
  const isOnline = req.body.isOnline ?? true;
  userPresenceMap.set(auth.userId, { isOnline, lastSeen: Date.now() });
  res.json({ success: true });
});

// 11. POST /chats/:chatId/read & PATCH /chats/:chatId/read — Mark chat messages as read
router.post('/:chatId/read', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    await prisma.chatParticipant.updateMany({
      where: { chatId, userId: auth.userId },
      data: { unreadCount: 0 },
    });

    broadcast('chat_read', chatId, { chatId, userId: auth.userId });
    res.json({ success: true, message: 'Chat marked as read' });
  } catch (err) {
    res.json({ success: true });
  }
});

router.patch('/:chatId/read', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    await prisma.chatParticipant.updateMany({
      where: { chatId, userId: auth.userId },
      data: { unreadCount: 0 },
    });

    broadcast('chat_read', chatId, { chatId, userId: auth.userId });
    res.json({ success: true, message: 'Chat marked as read' });
  } catch (err) {
    res.json({ success: true });
  }
});

// 11b. POST /chats/:chatId/archive & PATCH /chats/:chatId/archive
router.patch('/:chatId/archive', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;
    const { archived = true } = req.body;

    broadcast('chat_archived', chatId, { chatId, userId: auth.userId, archived });
    res.json({ success: true, archived });
  } catch (err) {
    res.json({ success: true, archived: true });
  }
});

router.post('/:chatId/archive', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;
    const { archived = true } = req.body;

    broadcast('chat_archived', chatId, { chatId, userId: auth.userId, archived });
    res.json({ success: true, archived });
  } catch (err) {
    res.json({ success: true, archived: true });
  }
});

// 11c. PATCH /chats/:chatId/leave — Leave group
router.patch('/:chatId/leave', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    await prisma.chatParticipant.deleteMany({
      where: { chatId, userId: auth.userId },
    });

    broadcast('chat_member_left', chatId, { chatId, userId: auth.userId });
    res.json({ success: true, message: 'Left group' });
  } catch (err) {
    res.json({ success: true });
  }
});

// 12. PATCH /chats/messages/:messageId/status — Update message status
router.patch('/messages/:messageId/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const { messageId } = req.params;
    const { status } = req.body;

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { status: status || 'read' },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    res.json({ success: true });
  }
});

// 13. PATCH /chats/:chatId — Rename group or update chat metadata
router.patch('/:chatId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;
    const { title, name, participants, memberIds, admins, block, unblock, clearFor, disappearingTimer, joinLink, joinLinkCode } = req.body;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: { include: { user: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });

    // Handle block / unblock directly from chat room
    if (block) {
      const otherUser = chat.participants.find(p => p.userId !== auth.userId)?.userId;
      if (otherUser) {
        const key = `blocked_users_${auth.userId}`;
        const setting = await prisma.setting.findUnique({ where: { key } });
        const list: string[] = Array.isArray(setting?.value) ? (setting?.value as string[]) : [];
        if (!list.includes(otherUser)) {
          list.push(otherUser);
          await prisma.setting.upsert({ where: { key }, create: { key, value: list }, update: { value: list } });
        }
      }
    }
    if (unblock) {
      const otherUser = chat.participants.find(p => p.userId !== auth.userId)?.userId;
      if (otherUser) {
        const key = `blocked_users_${auth.userId}`;
        const setting = await prisma.setting.findUnique({ where: { key } });
        const list: string[] = Array.isArray(setting?.value) ? (setting?.value as string[]) : [];
        const filtered = list.filter(id => id !== otherUser);
        await prisma.setting.upsert({ where: { key }, create: { key, value: filtered }, update: { value: filtered } });
      }
    }

    // Handle participant synchronization
    const incomingParticipants = participants || memberIds;
    if (Array.isArray(incomingParticipants) && incomingParticipants.length > 0) {
      await prisma.chatParticipant.deleteMany({
        where: {
          chatId,
          userId: { notIn: incomingParticipants },
        },
      });
      for (const uid of incomingParticipants) {
        await prisma.chatParticipant.upsert({
          where: { chatId_userId: { chatId, userId: uid } },
          create: { chatId, userId: uid },
          update: {},
        });
      }
    }

    // Handle title update
    const newTitle = (title || name || '').trim();
    if (newTitle) {
      await prisma.chat.update({
        where: { id: chatId },
        data: { title: newTitle },
      });
    }

    // Handle disappearingTimer / joinLink
    if (disappearingTimer !== undefined || joinLink !== undefined || admins !== undefined) {
      const key = `chat_settings_${chatId}`;
      const existing = await prisma.setting.findUnique({ where: { key } });
      const currentVal = (existing?.value as any) || {};
      const updatedVal = {
        ...currentVal,
        ...(disappearingTimer !== undefined ? { disappearingTimer } : {}),
        ...(joinLink !== undefined ? { joinLink, joinLinkCode } : {}),
        ...(admins !== undefined ? { admins } : {}),
      };
      await prisma.setting.upsert({ where: { key }, create: { key, value: updatedVal }, update: { value: updatedVal } });
    }

    const updatedChat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: { include: { user: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const formatted = formatChat(updatedChat, auth.userId);
    broadcast('chat', chatId, formatted);
    res.json({ success: true, data: formatted });
  } catch (err: any) {
    console.error('[chats:patch]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update chat' });
  }
});

// 14. DELETE /chats/:chatId — Leave or delete chat
router.delete('/:chatId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });
    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });

    // Always delete this user's participation
    await prisma.chatParticipant.deleteMany({
      where: { chatId, userId: auth.userId },
    });

    // Save in user's deleted/hidden list
    const key = `deleted_chats_${auth.userId}`;
    const setting = await prisma.setting.findUnique({ where: { key } });
    const list: string[] = Array.isArray(setting?.value) ? (setting?.value as string[]) : [];
    if (!list.includes(chatId)) {
      list.push(chatId);
      await prisma.setting.upsert({ where: { key }, create: { key, value: list }, update: { value: list } });
    }

    // If direct chat, or created by user, or 0 participants left, delete the entire chat and messages
    const isDirect = chat.type === 'direct' || !chat.type;
    const remainingCount = await prisma.chatParticipant.count({ where: { chatId } });
    if (isDirect || chat.createdById === auth.userId || remainingCount === 0) {
      await prisma.message.deleteMany({ where: { chatId } }).catch(() => {});
      await prisma.chatParticipant.deleteMany({ where: { chatId } }).catch(() => {});
      await prisma.chat.delete({ where: { id: chatId } }).catch(() => {});
      broadcast('chat_deleted', chatId, { chatId });
    } else {
      broadcast('chat_member_left', chatId, { chatId, userId: auth.userId });
    }

    res.json({ success: true, message: 'Chat removed successfully' });
  } catch (err) {
    console.error('[chats:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete chat' });
  }
});

// 15. POST /chats/:chatId/participants — Add participants to group chat
router.post('/:chatId/participants', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const { userIds = [], memberIds = [] } = req.body;
    const targets = Array.from(new Set([...userIds, ...memberIds]));

    for (const uId of targets) {
      await prisma.chatParticipant.upsert({
        where: { chatId_userId: { chatId, userId: uId } },
        create: { chatId, userId: uId },
        update: {},
      });
    }

    const updated = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: { include: { user: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const formatted = formatChat(updated, res.locals.auth.userId);
    broadcast('chat', chatId, formatted);
    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[chats:participants:add]', err);
    res.status(500).json({ success: false, error: 'Failed to add members' });
  }
});

// 16. DELETE /chats/:chatId/participants/:targetUserId — Remove participant from group
router.delete('/:chatId/participants/:targetUserId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId, targetUserId } = req.params;

    await prisma.chatParticipant.deleteMany({
      where: { chatId, userId: targetUserId },
    });

    const updated = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: { include: { user: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const formatted = formatChat(updated, res.locals.auth.userId);
    broadcast('chat', chatId, formatted);
    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[chats:participants:remove]', err);
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

// 17. POST /chats/:chatId/messages/:messageId/reactions — Toggle message reaction
router.post('/:chatId/messages/:messageId/reactions', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId, messageId } = req.params;
    const { reaction, emoji } = req.body;
    const auth = res.locals.auth;

    broadcast('message_reaction', chatId, {
      messageId,
      userId: auth.userId,
      reaction: reaction || emoji,
    });

    res.json({ success: true });
  } catch (err) {
    res.json({ success: true });
  }
});

// 18. POST /chats/requests/:chatId/accept — Accept message request
router.post('/requests/:chatId/accept', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    // Save acceptance in settings/metadata
    const key = `chat_accepted_${auth.userId}_${chatId}`;
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: { accepted: true, acceptedAt: new Date().toISOString() } },
      update: { value: { accepted: true, acceptedAt: new Date().toISOString() } },
    });

    broadcast('chat_accepted', chatId, { chatId, userId: auth.userId });
    res.json({ success: true, message: 'Chat request accepted' });
  } catch (err: any) {
    console.error('[chats:requests:accept]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to accept request' });
  }
});

// 19. POST /chats/requests/:chatId/decline — Decline message request
router.post('/requests/:chatId/decline', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    await prisma.chatParticipant.deleteMany({
      where: { chatId, userId: auth.userId },
    });

    res.json({ success: true, message: 'Chat request declined' });
  } catch (err: any) {
    console.error('[chats:requests:decline]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to decline request' });
  }
});

// 20. GET /chats/users/blocked — Get user's blocked list
router.get('/users/blocked', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const key = `blocked_users_${auth.userId}`;
    const setting = await prisma.setting.findUnique({ where: { key } });
    const blockedIds: string[] = Array.isArray(setting?.value) ? (setting?.value as string[]) : [];

    let users: any[] = [];
    if (blockedIds.length > 0) {
      users = await prisma.user.findMany({
        where: { id: { in: blockedIds } },
        select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true },
      });
    }

    res.json({ success: true, count: users.length, data: users });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to get blocked users' });
  }
});

// 21. POST /chats/users/block — Block a user
router.post('/users/block', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ success: false, error: 'targetUserId is required' });

    const key = `blocked_users_${auth.userId}`;
    const setting = await prisma.setting.findUnique({ where: { key } });
    const currentList: string[] = Array.isArray(setting?.value) ? (setting?.value as string[]) : [];

    if (!currentList.includes(targetUserId)) {
      currentList.push(targetUserId);
      await prisma.setting.upsert({
        where: { key },
        create: { key, value: currentList },
        update: { value: currentList },
      });
    }

    res.json({ success: true, message: 'User blocked successfully' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to block user' });
  }
});

// 22. DELETE /chats/users/block/:targetUserId — Unblock a user
router.delete('/users/block/:targetUserId', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { targetUserId } = req.params;

    const key = `blocked_users_${auth.userId}`;
    const setting = await prisma.setting.findUnique({ where: { key } });
    const currentList: string[] = Array.isArray(setting?.value) ? (setting?.value as string[]) : [];
    const updatedList = currentList.filter(id => id !== targetUserId);

    await prisma.setting.upsert({
      where: { key },
      create: { key, value: updatedList },
      update: { value: updatedList },
    });

    res.json({ success: true, message: 'User unblocked successfully' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to unblock user' });
  }
});

// 23. PATCH /chats/:chatId/participants/:targetUserId/role — Promote / Demote admin
router.patch('/:chatId/participants/:targetUserId/role', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId, targetUserId } = req.params;
    const { role = 'admin' } = req.body;
    const auth = res.locals.auth;

    // Verify requesting user is creator or admin
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });
    if (chat.createdById !== auth.userId && auth.role !== 'admin' && auth.role !== 'hq_admin') {
      return res.status(403).json({ success: false, error: 'Only group creator can promote admins' });
    }

    const key = `chat_role_${chatId}_${targetUserId}`;
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: { role } },
      update: { value: { role } },
    });

    broadcast('chat_participant_role', chatId, { chatId, userId: targetUserId, role });
    res.json({ success: true, message: `Participant role updated to ${role}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update participant role' });
  }
});

// 24. PATCH /chats/:chatId/settings — Update group permissions (e.g. adminOnlySend)
router.patch('/:chatId/settings', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const { adminOnlySend, description } = req.body;
    const auth = res.locals.auth;

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });

    const key = `chat_settings_${chatId}`;
    const existing = await prisma.setting.findUnique({ where: { key } });
    const currentVal: any = existing?.value || {};
    const updatedVal = {
      ...currentVal,
      ...(adminOnlySend !== undefined ? { adminOnlySend } : {}),
      ...(description !== undefined ? { description } : {}),
    };

    await prisma.setting.upsert({
      where: { key },
      create: { key, value: updatedVal },
      update: { value: updatedVal },
    });

    broadcast('chat_settings_updated', chatId, { chatId, settings: updatedVal });
    res.json({ success: true, data: updatedVal });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update chat settings' });
  }
});

export default router;
