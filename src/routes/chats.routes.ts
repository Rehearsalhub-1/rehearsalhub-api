import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function formatMessage(m: any) {
  const sender = m.sender || {};
  return {
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    senderName: [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.email || 'User',
    senderAvatar: sender.avatarUrl || null,
    text: m.text || '',
    type: m.type || 'text',
    status: m.status || 'sent',
    edited: m.edited || false,
    createdAt: m.createdAt,
  };
}

function formatChat(c: any, currentUserId?: string) {
  const participants = Array.isArray(c.participants) ? c.participants.map((p: any) => p.userId || p.id) : [];
  const details: Record<string, any> = {};

  if (Array.isArray(c.participants)) {
    for (const p of c.participants) {
      const u = p.user || p;
      if (u.id) {
        details[u.id] = {
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Member',
          avatar: u.avatarUrl || null,
          email: u.email || null,
        };
      }
    }
  }

  const lastMsg = Array.isArray(c.messages) && c.messages.length > 0 ? c.messages[0] : null;

  return {
    id: c.id,
    title: c.title || 'Chat',
    name: c.title || 'Chat',
    type: c.type || 'direct',
    organizationId: c.organizationId || null,
    createdById: c.createdById,
    participants,
    participantDetails: details,
    lastMessage: lastMsg?.text || null,
    lastTimestamp: lastMsg?.createdAt || c.createdAt,
    unreadCount: 0,
    createdAt: c.createdAt,
  };
}

// 1. GET /chats — List chats for authenticated user (Strict Channel Isolation)
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;

    const chatRows = await prisma.chat.findMany({
      where: {
        participants: {
          some: { userId },
        },
      },
      include: {
        participants: {
          include: { user: true },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = chatRows.map((c) => formatChat(c, userId));
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
        },
      },
    });

    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });
    const isParticipant = chat.participants.some((p) => p.userId === userId);
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
    const chatTitle = title || name || (type === 'direct' ? 'Direct Message' : 'Group Chat');
    const orgId = organizationId || zoneId || req.tenant?.effectiveZoneId || null;

    // For direct chats between 2 people, check if one already exists
    if (type === 'direct' && rawParticipants.length === 2) {
      const [p1, p2] = rawParticipants;
      const existing = await prisma.chat.findFirst({
        where: {
          type: 'direct',
          AND: [
            { participants: { some: { userId: p1 } } },
            { participants: { some: { userId: p2 } } },
          ],
        },
        include: {
          participants: { include: { user: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });

      if (existing) {
        return res.json({ success: true, data: formatChat(existing, auth.userId) });
      }
    }

    const chatId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const newChat = await prisma.chat.create({
      data: {
        id: chatId,
        type,
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
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const formatted = formatChat(newChat, auth.userId);
    broadcast('chat', chatId, formatted);
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

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: { participants: true },
    });

    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });
    const isParticipant = chat.participants.some((p) => p.userId === auth.userId);
    if (!isParticipant) return res.status(403).json({ success: false, error: 'Forbidden' });

    const messageId = req.body.id || crypto.randomUUID();

    const message = await prisma.message.create({
      data: {
        id: messageId,
        chatId,
        senderId: auth.userId,
        text,
        type: req.body.type || 'text',
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

    const formatted = formatMessage(message);
    broadcast('chat', chatId, formatted);
    broadcast('messages', chatId, formatted);
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

// 11. POST /chats/:chatId/read — Mark chat messages as read
router.post('/:chatId/read', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    await prisma.chatParticipant.updateMany({
      where: { chatId, userId: auth.userId },
      data: { unreadCount: 0 },
    });

    broadcast('chat_read', chatId, { chatId, userId: auth.userId });
    res.json({ success: true });
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
    const { title, name } = req.body;

    const updated = await prisma.chat.update({
      where: { id: chatId },
      data: {
        title: (title || name || '').trim() || undefined,
      },
      include: {
        participants: { include: { user: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const formatted = formatChat(updated, res.locals.auth.userId);
    broadcast('chat', chatId, formatted);
    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[chats:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update chat' });
  }
});

// 14. DELETE /chats/:chatId — Leave or delete chat
router.delete('/:chatId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const auth = res.locals.auth;

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    if (!chat) return res.status(404).json({ success: false, error: 'Chat not found' });

    if (chat.createdById === auth.userId) {
      await prisma.chat.delete({ where: { id: chatId } });
      broadcast('chat_deleted', chatId, { chatId });
    } else {
      await prisma.chatParticipant.deleteMany({
        where: { chatId, userId: auth.userId },
      });
    }

    res.json({ success: true, message: 'Chat removed' });
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

export default router;
