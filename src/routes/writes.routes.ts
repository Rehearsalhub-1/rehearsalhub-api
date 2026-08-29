/**
 * Write endpoints for Phase 9.
 * Every mutation broadcasts to WebSocket subscribers of the affected resource.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

export const writesRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function forbidden(res: any) {
  res.status(403).json({ success: false, error: 'Forbidden' });
}

function notFound(res: any) {
  res.status(404).json({ success: false, error: 'Not found' });
}

// ── Subscriptions write ───────────────────────────────────────────────────────

writesRouter.patch('/subscriptions/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const auth = res.locals.auth;
  if (auth.userId !== userId && auth.role !== 'hq_admin') { forbidden(res); return; }

  const schema = z.object({
    status: z.enum(['active', 'inactive', 'expired']).optional(),
    plan: z.string().optional(),
    expires_at: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const profile = await prisma.profile.findUnique({ where: { id: userId } });
  if (!profile) { notFound(res); return; }

  const prevRaw = (profile.rawData && typeof profile.rawData === 'object') ? (profile.rawData as Record<string, any>) : {};
  const currentSub = prevRaw.subscription || { id: `sub_${profile.id}`, userId: profile.id, status: 'active', plan: 'premium' };
  const updatedSub = {
    ...currentSub,
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.plan ? { plan: parsed.data.plan } : {}),
    ...(parsed.data.expires_at ? { expiresAt: parsed.data.expires_at } : {}),
    updatedAt: new Date().toISOString(),
  };

  await prisma.profile.update({
    where: { id: userId },
    data: { rawData: { ...prevRaw, subscription: updatedSub } },
  });

  broadcast('subscription', userId, updatedSub);
  res.json({ success: true, data: updatedSub });
});

// ── Chats & Messages ──────────────────────────────────────────────────────────

function chatMemberIds(chat: { participants?: unknown; rawData?: unknown }): string[] {
  if (Array.isArray(chat.participants)) {
    return (chat.participants as any[]).map(p => typeof p === 'string' ? p : p.userId);
  }
  const raw = chat.rawData && typeof chat.rawData === 'object' ? (chat.rawData as Record<string, unknown>) : {};
  if (Array.isArray(raw.participants)) return raw.participants as string[];
  if (Array.isArray(raw.memberIds)) return raw.memberIds as string[];
  return [];
}

writesRouter.post('/chats', requireAuth, async (req, res) => {
  const auth = res.locals.auth;

  const schema = z.object({
    name: z.string().optional(),
    type: z.string(),
    zone_id: z.string().optional(),
    member_ids: z.array(z.string()).min(1),
  }).strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const participants = parsed.data.member_ids.includes(auth.userId)
    ? parsed.data.member_ids
    : [...parsed.data.member_ids, auth.userId];

  const typeUpper = (parsed.data.type === 'direct' ? 'DIRECT' : parsed.data.type === 'announcement' ? 'ANNOUNCEMENT' : 'GROUP') as any;

  const chat = await prisma.chat.create({
    data: {
      id: crypto.randomUUID(),
      type: typeUpper,
      createdById: auth.userId,
      organizationId: parsed.data.zone_id || null,
      participants: {
        create: participants.map(uid => ({ userId: uid })),
      },
      rawData: {
        name: parsed.data.name,
        zoneId: parsed.data.zone_id,
        participants,
      },
    },
    include: { participants: true },
  });

  broadcast('chat', chat.id, chat);
  res.status(201).json({ success: true, data: chat });
});

writesRouter.patch('/chats/:chatId', requireAuth, async (req, res) => {
  const { chatId } = req.params;
  const auth = res.locals.auth;

  const schema = z.object({
    name: z.string().optional(),
    last_message: z.string().optional(),
    last_message_at: z.string().datetime().optional(),
    member_ids: z.array(z.string()).min(1).optional(),
  }).strict().refine((body) => Object.keys(body).length > 0, { message: 'Empty body' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { participants: true },
  });
  if (!chat) { notFound(res); return; }
  if (!chatMemberIds(chat).includes(auth.userId)) { forbidden(res); return; }

  const prevRaw =
    chat.rawData && typeof chat.rawData === 'object' ? (chat.rawData as Record<string, unknown>) : {};
  const nextRaw = {
    ...prevRaw,
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.last_message !== undefined ? { lastMessage: parsed.data.last_message } : {}),
    ...(parsed.data.last_message_at !== undefined ? { lastMessageAt: parsed.data.last_message_at } : {}),
  };

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
      rawData: nextRaw,
    },
    include: { participants: true },
  });

  broadcast('chat', chatId, updated);
  res.json({ success: true, data: updated });
});

// PATCH /chats/:chatId/messages/:msgId — edit text, star, or pin a message
writesRouter.patch('/chats/:chatId/messages/:msgId', requireAuth, async (req, res) => {
  const { chatId, msgId } = req.params;
  const auth = res.locals.auth;

  const schema = z.object({
    content: z.string().min(1).optional(),
    edited: z.boolean().optional(),
    starred: z.boolean().optional(),
    pinned: z.boolean().optional(),
  }).refine(b => Object.keys(b).length > 0, { message: 'Empty body' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { participants: true },
  });
  if (!chat) { notFound(res); return; }
  if (!chatMemberIds(chat).includes(auth.userId)) { forbidden(res); return; }

  const msg = await prisma.message.findUnique({ where: { id: msgId } });
  if (!msg) { notFound(res); return; }

  if (parsed.data.content !== undefined && msg.senderId !== auth.userId) { forbidden(res); return; }

  const prevRaw = msg.rawData && typeof msg.rawData === 'object' ? (msg.rawData as Record<string, unknown>) : {};
  const updated = await prisma.message.update({
    where: { id: msgId },
    data: {
      ...(parsed.data.content !== undefined ? { text: parsed.data.content, edited: true } : {}),
      rawData: {
        ...prevRaw,
        ...(parsed.data.starred !== undefined ? { starred: parsed.data.starred } : {}),
        ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
      },
    },
  });

  broadcast('messages', chatId, {
    type: 'edit',
    messageId: msgId,
    text: updated.text,
    edited: updated.edited,
    rawData: updated.rawData,
  });
  res.json({ success: true, data: updated });
});

// DELETE /chats/:chatId/messages/:msgId — soft-delete (sender only)
writesRouter.delete('/chats/:chatId/messages/:msgId', requireAuth, async (req, res) => {
  const { chatId, msgId } = req.params;
  const auth = res.locals.auth;

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { participants: true },
  });
  if (!chat) { notFound(res); return; }
  if (!chatMemberIds(chat).includes(auth.userId)) { forbidden(res); return; }

  const msg = await prisma.message.findUnique({ where: { id: msgId } });
  if (!msg) { notFound(res); return; }
  if (msg.senderId !== auth.userId) { forbidden(res); return; }

  const prevRaw = msg.rawData && typeof msg.rawData === 'object' ? (msg.rawData as Record<string, unknown>) : {};
  await prisma.message.update({
    where: { id: msgId },
    data: {
      text: 'This message was deleted',
      rawData: { ...prevRaw, deleted: true, deletedAt: new Date().toISOString() },
    },
  });

  broadcast('messages', chatId, { type: 'delete', messageId: msgId });
  res.json({ success: true });
});

writesRouter.patch('/calls/:callId', requireAuth, async (req, res) => {
  const { callId } = req.params;
  const auth = res.locals.auth;

  const schema = z.object({ status: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) { notFound(res); return; }

  const prevRaw = (call.rawData && typeof call.rawData === 'object') ? (call.rawData as Record<string, any>) : {};
  const callerId = prevRaw.callerId || prevRaw.caller_id;
  const receiverId = prevRaw.receiverId || prevRaw.receiver_id;
  if (callerId !== auth.userId && receiverId !== auth.userId) { forbidden(res); return; }

  const nextRaw = { ...prevRaw, status: parsed.data.status, updatedAt: new Date().toISOString() };
  const updated = await prisma.call.update({
    where: { id: callId },
    data: { rawData: nextRaw },
  });

  broadcast('call', callId, nextRaw);
  res.json({ success: true, data: nextRaw });
});

writesRouter.post('/calls', requireAuth, async (req, res) => {
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
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const id = crypto.randomUUID();
  const rawData = {
    id,
    callerId: auth.userId,
    receiverId: parsed.data.receiver_id,
    type: parsed.data.type,
    callerName: parsed.data.caller_name || 'Caller',
    callerAvatar: parsed.data.caller_avatar || null,
    chatId: parsed.data.chat_id || null,
    roomId: parsed.data.room_id || `call_${id}`,
    status: 'ringing',
    createdAt: new Date().toISOString(),
  };

  const call = await prisma.call.create({
    data: {
      id,
      rawData,
    },
  });

  broadcast('call', call.id, rawData);
  res.status(201).json({ success: true, data: rawData });
});

// ── Zone membership writes ────────────────────────────────────────────────────

writesRouter.post('/members/zone-switch', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const schema = z.object({ zone_code: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const existing = await prisma.profile.findUnique({ where: { id: auth.userId } });
  if (!existing) { notFound(res); return; }

  const raw =
    existing.rawData && typeof existing.rawData === 'object' && !Array.isArray(existing.rawData)
      ? { ...(existing.rawData as Record<string, unknown>) }
      : {};
  raw.zone_code = parsed.data.zone_code;
  raw.zoneCode = parsed.data.zone_code;

  const updatedProfile = await prisma.profile.update({
    where: { id: auth.userId },
    data: { rawData: raw as any, updatedAt: new Date().toISOString() },
  });

  if (updatedProfile) broadcast('profile', auth.userId, updatedProfile);
  res.json({ success: true });
});

writesRouter.post('/members/zone-join', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const schema = z.object({
    zone_id: z.string(),
    is_hq: z.boolean().default(false),
    user_email: z.string().optional(),
    user_name: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const orgId = parsed.data.zone_id || 'zone-001';
  if (parsed.data.is_hq) {
    await prisma.membership.upsert({
      where: { userId_organizationId: { userId: auth.userId, organizationId: 'zone-001' } },
      create: { userId: auth.userId, organizationId: 'zone-001', role: 'MEMBER', hasHqAccess: true },
      update: { hasHqAccess: true },
    });
  } else {
    await prisma.membership.upsert({
      where: { userId_organizationId: { userId: auth.userId, organizationId: orgId } },
      create: { userId: auth.userId, organizationId: orgId, role: 'MEMBER' },
      update: { status: 'ACTIVE' },
    });
  }

  res.status(201).json({ success: true });
});

// ── Annotations & Notes ───────────────────────────────────────────────────────

writesRouter.patch('/songs/annotations/:songId', requireAuth, async (req, res) => {
  const { songId } = req.params;
  const auth = res.locals.auth;
  const schema = z.object({ data: z.record(z.unknown()) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const ownRecord = await prisma.mediaDoodle.findFirst({
    where: { songId, userId: auth.userId },
  });

  if (ownRecord) {
    const updated = await prisma.mediaDoodle.update({
      where: { id: ownRecord.id },
      data: { data: parsed.data.data as any, rawData: { songId, userId: auth.userId, data: parsed.data.data, updatedAt: new Date().toISOString() } as any },
    });
    res.json({ success: true, data: updated });
  } else {
    const created = await prisma.mediaDoodle.create({
      data: {
        id: crypto.randomUUID(),
        userId: auth.userId,
        songId,
        data: parsed.data.data as any,
        createdAt: new Date(),
        rawData: { songId, userId: auth.userId, data: parsed.data.data, createdAt: new Date().toISOString() } as any,
      },
    });
    res.json({ success: true, data: created });
  }
});

writesRouter.patch('/songs/notes/:songId', requireAuth, async (req, res) => {
  const { songId } = req.params;
  const auth = res.locals.auth;
  const schema = z.object({ notes: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const noteId = `note_${auth.userId}_${songId}`;
  const updated = await prisma.userSongNote.upsert({
    where: { id: noteId },
    update: {
      rawData: { songId, userId: auth.userId, notes: parsed.data.notes, updatedAt: new Date().toISOString() },
    },
    create: {
      id: noteId,
      rawData: { songId, userId: auth.userId, notes: parsed.data.notes, createdAt: new Date().toISOString() },
    },
  });

  res.json({ success: true, data: updated });
});

// GET /songs/annotations/:songId — load user's doodle strokes for a song
writesRouter.get('/songs/annotations/:songId', requireAuth, async (req, res) => {
  const { songId } = req.params;
  const auth = res.locals.auth;

  const record = await prisma.mediaDoodle.findFirst({
    where: { songId, userId: auth.userId },
  });

  if (!record) {
    res.json({ success: true, data: null });
    return;
  }

  res.json({ success: true, data: record });
});

// ── OneSignal subscription ID ─────────────────────────────────────────────────

writesRouter.patch('/profiles/:userId/onesignal', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const auth = res.locals.auth;
  if (auth.userId !== userId) { forbidden(res); return; }

  const schema = z.object({ subscription_id: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

  const existing = await prisma.profile.findUnique({ where: { id: userId } });
  if (!existing) { notFound(res); return; }

  const raw =
    existing.rawData && typeof existing.rawData === 'object' && !Array.isArray(existing.rawData)
      ? { ...(existing.rawData as Record<string, unknown>) }
      : {};
  raw.onesignal_sub_id = parsed.data.subscription_id;

  const updatedProfile = await prisma.profile.update({
    where: { id: userId },
    data: { rawData: raw as any, updatedAt: new Date().toISOString() },
  });

  if (updatedProfile) broadcast('profile', userId, updatedProfile);
  res.json({ success: true });
});
