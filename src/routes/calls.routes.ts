import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';
import { mergeRawRow } from '../lib/rawRow';

const router = Router();

function shapeCall(c: any, profileMap: Record<string, { name: string; avatar: string | null }>) {
  const merged = mergeRawRow(c);
  const raw = (c.rawData && typeof c.rawData === 'object') ? (c.rawData as Record<string, any>) : {};

  const callerId = raw.callerId || raw.caller_id;
  const receiverId = raw.receiverId || raw.receiver_id;
  const callerProf = callerId ? profileMap[callerId] : null;
  const receiverProf = receiverId ? profileMap[receiverId] : null;

  let rawTime = raw.timestamp || raw.startedAt || raw.createdAt || raw.created_at;
  let timestampISO = new Date().toISOString();
  if (rawTime) {
    if (typeof rawTime === 'object' && rawTime._seconds) {
      timestampISO = new Date(rawTime._seconds * 1000).toISOString();
    } else if (rawTime instanceof Date) {
      timestampISO = rawTime.toISOString();
    } else if (typeof rawTime === 'string') {
      timestampISO = rawTime;
    }
  }

  return {
    ...merged,
    id: c.id,
    callerId,
    receiverId,
    callerName: (raw.callerName && raw.callerName !== 'Caller') ? raw.callerName : (callerProf?.name || 'Caller'),
    callerAvatar: raw.callerAvatar || callerProf?.avatar || null,
    receiverName: raw.receiverName || receiverProf?.name || 'Member',
    receiverAvatar: raw.receiverAvatar || receiverProf?.avatar || null,
    type: raw.type || 'voice',
    status: raw.status || 'ended',
    duration: raw.duration || 0,
    chatId: raw.chatId || raw.chat_id,
    createdAt: timestampISO,
    timestamp: timestampISO,
  };
}

// GET /calls — Call history for current user
router.get('/', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const userId = auth.userId as string;

    const userCalls = await prisma.call.findMany({
      where: {
        OR: [
          { rawData: { path: ['callerId'], equals: userId } },
          { rawData: { path: ['receiverId'], equals: userId } },
          { rawData: { path: ['caller_id'], equals: userId } },
          { rawData: { path: ['receiver_id'], equals: userId } },
          { rawData: { path: ['participants'], array_contains: userId } },
        ],
      },
      take: 100,
    });

    const userIds = Array.from(new Set(userCalls.flatMap(c => {
      const raw = (c.rawData && typeof c.rawData === 'object') ? (c.rawData as any) : {};
      return [raw.callerId, raw.receiverId, raw.caller_id, raw.receiver_id];
    }).filter(Boolean))) as string[];

    const profileMap: Record<string, { name: string; avatar: string | null }> = {};
    if (userIds.length > 0) {
      const userProfiles = await prisma.user.findMany({ where: { id: { in: userIds } } });
      for (const p of userProfiles) {
        const raw = (p.rawData && typeof p.rawData === 'object') ? (p.rawData as any) : {};
        const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || raw.name || raw.displayName || p.email || 'Member';
        const avatar = p.avatarUrl || raw.avatar || raw.profile_image_url || null;
        profileMap[p.id] = { name, avatar };
      }
    }

    const enrichedCalls = userCalls.map(c => shapeCall(c, profileMap));
    enrichedCalls.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

    res.json({ success: true, count: enrichedCalls.length, data: enrichedCalls });
  } catch (err) {
    console.error('[calls:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load call history' });
  }
});

// GET /calls/:callId — Get specific call details
router.get('/:callId', requireAuth, async (req, res) => {
  try {
    const call = await prisma.call.findUnique({ where: { id: req.params.callId } });
    if (!call) { 
      res.status(404).json({ success: false, error: 'Call not found' }); 
      return; 
    }
    const raw = (call.rawData && typeof call.rawData === 'object') ? (call.rawData as Record<string, any>) : {};
    const callerId = raw.callerId || raw.caller_id;
    const receiverId = raw.receiverId || raw.receiver_id;
    if (callerId !== res.locals.auth.userId && receiverId !== res.locals.auth.userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    res.json({ success: true, data: mergeRawRow(call) });
  } catch (err) {
    console.error('[calls/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load call' });
  }
});

// POST /calls — Initiate a voice or video call
router.post('/', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const { 
      receiver_id, 
      receiverId, 
      type = 'voice', 
      chat_id, 
      chatId, 
      caller_name, 
      callerName, 
      caller_avatar, 
      callerAvatar,
      room_id,
      roomId
    } = req.body;

    const targetReceiverId = receiver_id || receiverId;
    if (!targetReceiverId || targetReceiverId === auth.userId) {
      res.status(400).json({ success: false, error: 'receiver_id is required' });
      return;
    }
    const receiver = await prisma.user.findUnique({ where: { id: targetReceiverId } });
    if (!receiver) {
      res.status(404).json({ success: false, error: 'Receiver not found' });
      return;
    }

    const id = crypto.randomUUID();
    const generatedRoomId = room_id || roomId || `call_${id}`;
    const now = new Date().toISOString();

    const rawData = {
      id,
      callerId: auth.userId,
      receiverId: targetReceiverId,
      type: type === 'video' ? 'video' : 'voice',
      callerName: caller_name || callerName || 'Caller',
      callerAvatar: caller_avatar || callerAvatar || null,
      chatId: chat_id || chatId || null,
      roomId: generatedRoomId,
      status: 'ringing',
      createdAt: now,
      startedAt: now,
    };

    const call = await prisma.call.create({
      data: {
        id,
        rawData,
      },
    });

    broadcast('call', call.id, rawData);
    broadcast('incoming_call', targetReceiverId, rawData);
    res.status(201).json({ success: true, data: rawData });
  } catch (err) {
    console.error('[calls:post]', err);
    res.status(500).json({ success: false, error: 'Failed to initiate call' });
  }
});

// PATCH /calls/:callId — Update call status (answered, declined, ended)
router.patch('/:callId', requireAuth, async (req, res) => {
  try {
    const { callId } = req.params;
    const { status } = req.body;
    const auth = res.locals.auth;
    const allowedStatuses = new Set(['ringing', 'answered', 'accepted', 'ended', 'declined', 'missed']);
    if (typeof status !== 'string' || !allowedStatuses.has(status)) {
      res.status(400).json({ success: false, error: 'Invalid call status' });
      return;
    }

    const existing = await prisma.call.findUnique({ where: { id: callId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Call not found' });
      return;
    }
    const raw = (existing.rawData && typeof existing.rawData === 'object') ? (existing.rawData as Record<string, any>) : {};
    const callerId = raw.callerId || raw.caller_id;
    const receiverId = raw.receiverId || raw.receiver_id;

    if (callerId !== auth.userId && receiverId !== auth.userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const now = new Date().toISOString();
    const updatedRaw = {
      ...raw,
      status,
      ...(status === 'answered' || status === 'accepted' ? { startedAt: now } : {}),
      ...(status === 'ended' || status === 'declined' || status === 'missed' ? { endedAt: now } : {}),
    };

    await prisma.call.update({
      where: { id: callId },
      data: { rawData: updatedRaw },
    });

    broadcast('call', callId, updatedRaw);
    if (receiverId) broadcast('call_status', receiverId, updatedRaw);
    if (callerId) broadcast('call_status', callerId, updatedRaw);
    res.json({ success: true, data: updatedRaw });
  } catch (err) {
    console.error('[calls/:id:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update call' });
  }
});

// POST /calls/:callId/signal — WebRTC signaling relay (offer, answer, ICE candidates)
router.post('/:callId/signal', requireAuth, async (req, res) => {
  try {
    const { callId } = req.params;
    const { signal, targetUserId } = req.body;
    const auth = res.locals.auth;

    const call = await prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      res.status(404).json({ success: false, error: 'Call not found' });
      return;
    }
    const raw = (call.rawData && typeof call.rawData === 'object') ? (call.rawData as Record<string, any>) : {};
    const callerId = raw.callerId || raw.caller_id;
    const receiverId = raw.receiverId || raw.receiver_id;

    if (callerId !== auth.userId && receiverId !== auth.userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const destination = targetUserId || (callerId === auth.userId ? receiverId : callerId);
    if (destination !== callerId && destination !== receiverId) {
      res.status(403).json({ success: false, error: 'Forbidden destination' });
      return;
    }

    broadcast('call_signal', destination, {
      callId,
      from: auth.userId,
      signal,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[calls/:id/signal]', err);
    res.status(500).json({ success: false, error: 'Failed to send signal' });
  }
});

// DELETE /calls/:callId — Delete a specific call log
router.delete('/:callId', requireAuth, async (req, res) => {
  try {
    const { callId } = req.params;
    const auth = res.locals.auth;

    const existing = await prisma.call.findUnique({ where: { id: callId } });
    if (existing) {
      const raw = (existing.rawData && typeof existing.rawData === 'object') ? (existing.rawData as Record<string, any>) : {};
      const callerId = raw.callerId || raw.caller_id;
      const receiverId = raw.receiverId || raw.receiver_id;
      if (callerId === auth.userId || receiverId === auth.userId) {
        await prisma.call.delete({ where: { id: callId } });
      }
    }
    res.json({ success: true, message: 'Call log deleted' });
  } catch (err) {
    console.error('[calls/:id:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete call log' });
  }
});

// DELETE /calls — Batch delete call logs
router.delete('/', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    const auth = res.locals.auth;

    if (Array.isArray(ids) && ids.length > 0) {
      await prisma.call.deleteMany({
        where: {
          id: { in: ids },
          OR: [
            { rawData: { path: ['callerId'], equals: auth.userId } },
            { rawData: { path: ['receiverId'], equals: auth.userId } },
          ],
        },
      });
    }
    res.json({ success: true, message: 'Call logs deleted' });
  } catch (err) {
    console.error('[calls:batchDelete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete call logs' });
  }
});

export default router;
