/**
 * Write endpoints for Real-time mutations.
 * Every mutation broadcasts to WebSocket subscribers of the affected resource.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

export const writesRouter = Router();

function forbidden(res: Response) {
  res.status(403).json({ success: false, error: 'Forbidden' });
}

function notFound(res: Response) {
  res.status(404).json({ success: false, error: 'Not found' });
}

// ── Subscriptions write ───────────────────────────────────────────────────────

writesRouter.patch('/subscriptions/:userId', requireAuth, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const auth = res.locals.auth;
  if (auth.userId !== userId && auth.role !== 'hq_admin' && auth.role !== 'org_admin') {
    forbidden(res);
    return;
  }

  const schema = z.object({
    status: z.enum(['active', 'inactive', 'expired']).optional(),
    plan: z.string().optional(),
    expires_at: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid body' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    notFound(res);
    return;
  }

  const updatedSub = {
    id: `sub_${user.id}`,
    userId: user.id,
    status: parsed.data.status || 'active',
    plan: parsed.data.plan || 'premium',
    expiresAt: parsed.data.expires_at || null,
    updatedAt: new Date().toISOString(),
  };

  broadcast('subscription', userId, updatedSub);
  res.json({ success: true, data: updatedSub });
});

// ── Chats & Messages ──────────────────────────────────────────────────────────

writesRouter.post('/chats', requireAuth, async (req: Request, res: Response) => {
  const auth = res.locals.auth;

  const schema = z.object({
    name: z.string().optional(),
    type: z.string().default('direct'),
    zone_id: z.string().optional(),
    member_ids: z.array(z.string()).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid body' });
    return;
  }

  const participants = parsed.data.member_ids.includes(auth.userId)
    ? parsed.data.member_ids
    : [...parsed.data.member_ids, auth.userId];

  const chat = await prisma.chat.create({
    data: {
      id: crypto.randomUUID(),
      title: parsed.data.name || null,
      type: parsed.data.type || 'direct',
      createdById: auth.userId,
      organizationId: parsed.data.zone_id || null,
      participants: {
        create: participants.map((uid) => ({ userId: uid })),
      },
    },
    include: { participants: true },
  });

  broadcast('chat', chat.id, chat);
  res.status(201).json({ success: true, data: chat });
});

writesRouter.patch('/chats/:chatId', requireAuth, async (req: Request, res: Response) => {
  const { chatId } = req.params;
  const auth = res.locals.auth;

  const schema = z.object({
    name: z.string().optional(),
    member_ids: z.array(z.string()).min(1).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid body' });
    return;
  }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { participants: true },
  });
  if (!chat) {
    notFound(res);
    return;
  }

  const isMember = chat.participants.some((p) => p.userId === auth.userId);
  if (!isMember && chat.createdById !== auth.userId) {
    forbidden(res);
    return;
  }

  if (parsed.data.member_ids !== undefined) {
    for (const uid of parsed.data.member_ids) {
      await prisma.chatParticipant.upsert({
        where: { chatId_userId: { chatId, userId: uid } },
        create: { chatId, userId: uid },
        update: {},
      }).catch(() => {});
    }
  }

  const updated = await prisma.chat.update({
    where: { id: chatId },
    data: {
      ...(parsed.data.name !== undefined ? { title: parsed.data.name } : {}),
    },
    include: { participants: true },
  });

  broadcast('chat', chatId, updated);
  res.json({ success: true, data: updated });
});

// PATCH /chats/:chatId/messages/:msgId — edit text
writesRouter.patch('/chats/:chatId/messages/:msgId', requireAuth, async (req: Request, res: Response) => {
  const { chatId, msgId } = req.params;
  const auth = res.locals.auth;

  const schema = z.object({
    content: z.string().min(1).optional(),
    edited: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid body' });
    return;
  }

  const msg = await prisma.message.findUnique({ where: { id: msgId } });
  if (!msg) {
    notFound(res);
    return;
  }

  if (msg.senderId !== auth.userId) {
    forbidden(res);
    return;
  }

  const updated = await prisma.message.update({
    where: { id: msgId },
    data: {
      ...(parsed.data.content !== undefined ? { text: parsed.data.content, edited: true } : {}),
    },
  });

  broadcast('messages', chatId, {
    type: 'edit',
    messageId: msgId,
    text: updated.text,
    edited: updated.edited,
  });
  res.json({ success: true, data: updated });
});

// DELETE /chats/:chatId/messages/:msgId — soft-delete (sender only)
writesRouter.delete('/chats/:chatId/messages/:msgId', requireAuth, async (req: Request, res: Response) => {
  const { chatId, msgId } = req.params;
  const auth = res.locals.auth;

  const msg = await prisma.message.findUnique({ where: { id: msgId } });
  if (!msg) {
    notFound(res);
    return;
  }
  if (msg.senderId !== auth.userId) {
    forbidden(res);
    return;
  }

  await prisma.message.update({
    where: { id: msgId },
    data: {
      text: 'This message was deleted',
    },
  });

  broadcast('messages', chatId, { type: 'delete', messageId: msgId });
  res.json({ success: true });
});

// ── WebRTC Calls ─────────────────────────────────────────────────────────────

writesRouter.post('/calls', requireAuth, async (req: Request, res: Response) => {
  const auth = res.locals.auth;

  const schema = z.object({
    receiver_id: z.string(),
    type: z.enum(['voice', 'video']).default('voice'),
    chat_id: z.string().optional(),
    room_id: z.string().optional(),
    caller_name: z.string().optional(),
    caller_avatar: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid body' });
    return;
  }

  const id = crypto.randomUUID();
  const call = await prisma.call.create({
    data: {
      id,
      callerId: auth.userId,
      receiverId: parsed.data.receiver_id,
      type: parsed.data.type,
      callerName: parsed.data.caller_name || 'Caller',
      callerAvatar: parsed.data.caller_avatar || null,
      chatId: parsed.data.chat_id || null,
      roomId: parsed.data.room_id || `call_${id}`,
      status: 'ringing',
    },
  });

  broadcast('call', call.id, call);
  res.status(201).json({ success: true, data: call });
});

writesRouter.patch('/calls/:callId', requireAuth, async (req: Request, res: Response) => {
  const { callId } = req.params;
  const auth = res.locals.auth;

  const schema = z.object({
    status: z.enum(['ringing', 'active', 'ended', 'missed', 'rejected']),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid body' });
    return;
  }

  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) {
    notFound(res);
    return;
  }

  if (call.callerId !== auth.userId && call.receiverId !== auth.userId) {
    forbidden(res);
    return;
  }

  const updated = await prisma.call.update({
    where: { id: callId },
    data: { status: parsed.data.status },
  });

  broadcast('call', callId, updated);
  res.json({ success: true, data: updated });
});

// ── Annotations & Notes ───────────────────────────────────────────────────────

writesRouter.patch('/songs/annotations/:songId', requireAuth, async (req: Request, res: Response) => {
  const { songId } = req.params;
  const auth = res.locals.auth;
  const schema = z.object({ data: z.record(z.unknown()) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid body' });
    return;
  }

  const updated = await prisma.mediaDoodle.upsert({
    where: { songId_userId: { songId, userId: auth.userId } },
    update: { data: parsed.data.data as any },
    create: {
      songId,
      userId: auth.userId,
      data: parsed.data.data as any,
    },
  });

  res.json({ success: true, data: updated });
});

writesRouter.get('/songs/annotations/:songId', requireAuth, async (req: Request, res: Response) => {
  const { songId } = req.params;
  const auth = res.locals.auth;

  const record = await prisma.mediaDoodle.findUnique({
    where: { songId_userId: { songId, userId: auth.userId } },
  });

  res.json({ success: true, data: record?.data || null });
});

writesRouter.patch('/songs/notes/:songId', requireAuth, async (req: Request, res: Response) => {
  const { songId } = req.params;
  const auth = res.locals.auth;
  const schema = z.object({ notes: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid body' });
    return;
  }

  const updated = await prisma.userSongNote.upsert({
    where: { songId_userId: { songId, userId: auth.userId } },
    update: { notes: parsed.data.notes },
    create: {
      songId,
      userId: auth.userId,
      notes: parsed.data.notes,
    },
  });

  res.json({ success: true, data: updated });
});

writesRouter.get('/songs/notes/:songId', requireAuth, async (req: Request, res: Response) => {
  const { songId } = req.params;
  const auth = res.locals.auth;

  const record = await prisma.userSongNote.findUnique({
    where: { songId_userId: { songId, userId: auth.userId } },
  });

  res.json({ success: true, data: record?.notes || '' });
});

export default writesRouter;
