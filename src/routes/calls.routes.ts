import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function shapeCall(c: any) {
  const caller = c.caller || {};
  const receiver = c.receiver || {};
  return {
    id: c.id,
    callerId: c.callerId,
    receiverId: c.receiverId,
    callerName: c.callerName || [caller.firstName, caller.lastName].filter(Boolean).join(' ') || caller.email || 'Caller',
    callerAvatar: c.callerAvatar || caller.avatarUrl || null,
    receiverName: [receiver.firstName, receiver.lastName].filter(Boolean).join(' ') || receiver.email || 'Member',
    receiverAvatar: receiver.avatarUrl || null,
    type: c.type || 'voice',
    status: c.status || 'ended',
    roomId: c.roomId || c.id,
    chatId: c.chatId || null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// Ensure calls table exists helper
let tableChecked = false;
async function ensureCallsTable() {
  if (tableChecked) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "calls" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "caller_id" TEXT NOT NULL,
        "receiver_id" TEXT NOT NULL,
        "type" TEXT NOT NULL DEFAULT 'voice',
        "chat_id" TEXT,
        "room_id" TEXT,
        "caller_name" TEXT,
        "caller_avatar" TEXT,
        "status" TEXT NOT NULL DEFAULT 'ended',
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "calls_caller_id_idx" ON "calls"("caller_id");
      CREATE INDEX IF NOT EXISTS "calls_receiver_id_idx" ON "calls"("receiver_id");
    `);
    tableChecked = true;
  } catch (e) {
    console.error('[calls:ensureTable]', e);
  }
}

// GET /calls — Call history for current user
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    await ensureCallsTable();
    const userId = res.locals.auth.userId as string;

    const userCalls = await prisma.call.findMany({
      where: {
        OR: [
          { callerId: userId },
          { receiverId: userId },
        ],
      },
      include: {
        caller: true,
        receiver: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json({ success: true, count: userCalls.length, data: userCalls.map(shapeCall) });
  } catch (err: any) {
    console.error('[calls:get]', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

// GET /calls/:callId — Get specific call details
router.get('/:callId', requireAuth, async (req: Request, res: Response) => {
  try {
    const call = await prisma.call.findUnique({
      where: { id: req.params.callId },
      include: { caller: true, receiver: true },
    });
    if (!call) return res.status(404).json({ success: false, error: 'Call not found' });
    res.json({ success: true, data: shapeCall(call) });
  } catch (err) {
    console.error('[calls:get:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load call details' });
  }
});

// POST /calls — Initiate or log a call
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { receiverId, type = 'voice', chatId, callerName, callerAvatar } = req.body;
    if (!receiverId) return res.status(400).json({ success: false, error: 'receiverId is required' });

    const callId = req.body.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const call = await prisma.call.create({
      data: {
        id: callId,
        callerId: auth.userId,
        receiverId,
        callerName: callerName || null,
        callerAvatar: callerAvatar || null,
        type,
        status: 'ringing',
        roomId: callId,
        chatId: chatId || null,
      },
      include: { caller: true, receiver: true },
    });

    const shaped = shapeCall(call);
    broadcast('calls', receiverId, { type: 'incoming_call', call: shaped });
    broadcast('call', callId, shaped);
    res.status(201).json({ success: true, data: shaped });
  } catch (err) {
    console.error('[calls:post]', err);
    res.status(500).json({ success: false, error: 'Failed to initiate call' });
  }
});

// PATCH /calls/:callId — Update call status (answered, rejected, ended)
router.patch('/:callId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { callId } = req.params;
    const { status } = req.body;

    const updated = await prisma.call.update({
      where: { id: callId },
      data: { status },
      include: { caller: true, receiver: true },
    });

    const shaped = shapeCall(updated);
    broadcast('call', callId, shaped);
    broadcast('calls', updated.callerId, { type: 'call_status', call: shaped });
    broadcast('calls', updated.receiverId, { type: 'call_status', call: shaped });

    res.json({ success: true, data: shaped });
  } catch (err) {
    console.error('[calls:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update call' });
  }
});

// DELETE /calls/:callId — Delete single call from history
router.delete('/:callId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { callId } = req.params;
    await prisma.call.delete({ where: { id: callId } }).catch(() => {});
    res.json({ success: true, message: 'Call deleted' });
  } catch (err) {
    res.json({ success: true });
  }
});

// DELETE /calls — Delete multiple calls by IDs
router.delete('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { ids = [] } = req.body;
    if (Array.isArray(ids) && ids.length > 0) {
      await prisma.call.deleteMany({ where: { id: { in: ids } } });
    }
    res.json({ success: true, message: 'Calls deleted' });
  } catch (err) {
    res.json({ success: true });
  }
});

export default router;
