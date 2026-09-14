import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';
import { sendExpoPushToUsers } from './notifications.routes';

const router = Router();

function shapeCall(c: any, callerMeta?: any, receiverMeta?: any) {
  const caller = c.caller || {};
  const receiver = c.receiver || {};
  const isGroup = Boolean(
    c.isGroup ||
    (c.chatId && (c.chatId.startsWith('group_') || c.chatId.startsWith('group'))) ||
    (c.receiverId && c.receiverId.startsWith('group')) ||
    c.type === 'group'
  );

  const callerDisplayName =
    (c.callerName && c.callerName !== 'Caller' && c.callerName !== 'Member' && c.callerName !== 'Me')
      ? c.callerName
      : callerMeta?.displayName ||
        (callerMeta?.firstName ? [callerMeta.firstName, callerMeta.lastName].filter(Boolean).join(' ') : null) ||
        callerMeta?.name ||
        [caller.firstName, caller.lastName].filter(Boolean).join(' ') ||
        caller.email ||
        'Caller';

  const callerAvatarUrl =
    c.callerAvatar ||
    callerMeta?.avatar ||
    callerMeta?.photoURL ||
    caller.avatarUrl ||
    null;

  const receiverDisplayName =
    (c.receiverName && c.receiverName !== 'Receiver' && c.receiverName !== 'Member')
      ? c.receiverName
      : receiverMeta?.displayName ||
        (receiverMeta?.firstName ? [receiverMeta.firstName, receiverMeta.lastName].filter(Boolean).join(' ') : null) ||
        receiverMeta?.name ||
        [receiver.firstName, receiver.lastName].filter(Boolean).join(' ') ||
        receiver.email ||
        (isGroup ? 'Group Call' : 'Member');

  const receiverAvatarUrl =
    c.receiverAvatar ||
    receiverMeta?.avatar ||
    receiverMeta?.photoURL ||
    receiver.avatarUrl ||
    null;

  return {
    id: c.id,
    callerId: c.callerId,
    receiverId: c.receiverId,
    callerName: callerDisplayName,
    callerAvatar: callerAvatarUrl,
    receiverName: receiverDisplayName,
    receiverAvatar: receiverAvatarUrl,
    type: c.type || 'voice',
    status: c.status || 'ended',
    roomId: c.roomId || c.id,
    chatId: c.chatId || null,
    isGroup,
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

    const userMemberships = await prisma.chatParticipant.findMany({
      where: { userId },
      select: { chatId: true },
    }).catch(() => []);
    const userChatIds = userMemberships.map((m: any) => m.chatId);

    const whereOr: any[] = [
      { callerId: userId },
      { receiverId: userId },
    ];
    if (userChatIds.length > 0) {
      whereOr.push({ chatId: { in: userChatIds } });
    }

    const userCalls = await prisma.call.findMany({
      where: { OR: whereOr },
      include: {
        caller: true,
        receiver: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const userIds = Array.from(new Set(userCalls.flatMap((c: any) => [c.callerId, c.receiverId]).filter(Boolean)));
    const metaKeys = userIds.map((id) => `profile_meta_${id}`);
    const metaSettings = metaKeys.length > 0 ? await prisma.setting.findMany({
      where: { key: { in: metaKeys } },
    }) : [];
    const metaMap = new Map<string, any>();
    metaSettings.forEach((s) => metaMap.set(s.key.replace('profile_meta_', ''), s.value));

    res.json({
      success: true,
      count: userCalls.length,
      data: userCalls.map((c: any) => shapeCall(c, metaMap.get(c.callerId), metaMap.get(c.receiverId))),
    });
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

    const [callerMetaRow, receiverMetaRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: `profile_meta_${call.callerId}` } }).catch(() => null),
      prisma.setting.findUnique({ where: { key: `profile_meta_${call.receiverId}` } }).catch(() => null),
    ]);

    res.json({
      success: true,
      data: shapeCall(call, callerMetaRow?.value, receiverMetaRow?.value),
    });
  } catch (err) {
    console.error('[calls:get:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load call details' });
  }
});

// POST /calls — Initiate or log a call
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const receiverId = req.body.receiverId || req.body.receiver_id;
    const type = req.body.type || 'voice';
    const chatId = req.body.chatId || req.body.chat_id || null;
    const callerName = req.body.callerName || req.body.caller_name || null;
    const callerAvatar = req.body.callerAvatar || req.body.caller_avatar || null;
    if (!receiverId) return res.status(400).json({ success: false, error: 'receiverId is required' });

    const callId = req.body.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Resolve caller and receiver metadata from database
    const [callerMetaRow, receiverMetaRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: `profile_meta_${auth.userId}` } }).catch(() => null),
      prisma.setting.findUnique({ where: { key: `profile_meta_${receiverId}` } }).catch(() => null),
    ]);
    const callerMeta = callerMetaRow?.value as any;
    const receiverMeta = receiverMetaRow?.value as any;

    const resolvedCallerName =
      (callerName && callerName !== 'Caller' && callerName !== 'Me')
        ? callerName
        : callerMeta?.displayName ||
          (callerMeta?.firstName ? [callerMeta.firstName, callerMeta.lastName].filter(Boolean).join(' ') : null) ||
          callerMeta?.name ||
          'Caller';
    const resolvedCallerAvatar = callerAvatar || callerMeta?.avatar || callerMeta?.photoURL || null;

    const call = await prisma.call.create({
      data: {
        id: callId,
        callerId: auth.userId,
        receiverId,
        callerName: resolvedCallerName,
        callerAvatar: resolvedCallerAvatar,
        type,
        status: 'ringing',
        roomId: callId,
        chatId: chatId || null,
      },
      include: { caller: true, receiver: true },
    });

    const shaped = shapeCall(call, callerMeta, receiverMeta);
    const participantIds: string[] = Array.isArray(req.body.participantIds) && req.body.participantIds.length > 0
      ? req.body.participantIds
      : [receiverId];

    for (const pid of participantIds) {
      if (pid && pid !== auth.userId) {
        broadcast('calls', pid, { type: 'incoming_call', call: shaped });
      }
    }
    if (chatId) broadcast('calls', chatId, { type: 'incoming_call', call: shaped });
    broadcast('call', callId, shaped);

    // Dispatch high-priority incoming call push notification
    const pushTargets = participantIds.filter((pid) => pid && pid !== auth.userId);
    if (pushTargets.length > 0) {
      sendExpoPushToUsers(pushTargets, {
        title: shaped.isGroup ? `${shaped.receiverName}: Incoming Call` : `Incoming ${type === 'video' ? 'Video' : 'Voice'} Call`,
        body: `${shaped.callerName} is calling you...`,
        data: {
          screen: 'IncomingCall',
          type: 'call',
          callId: shaped.id,
          callType: shaped.type,
          callerName: shaped.callerName,
          callerAvatar: shaped.callerAvatar || '',
          roomId: shaped.chatId || shaped.id,
          chatId: shaped.chatId || null,
        },
      }).catch((e) => console.warn('[calls:push]', e));
    }

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

    if (status === 'missed' || status === 'declined') {
      try {
        const callerName = shaped.callerName || 'Someone';
        const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const isVideo = updated.type === 'video';
        await prisma.notification.create({
          data: {
            id: notifId,
            title: `Missed ${isVideo ? 'video' : 'voice'} call`,
            body: `You missed a ${isVideo ? 'video' : 'voice'} call from ${callerName}`,
            type: 'call',
            category: 'call',
            actionUrl: `call/${callId}`,
            organizationId: req.tenant?.effectiveZoneId || 'zone-001',
            senderId: updated.callerId,
          },
        });
        await prisma.notificationDelivery.create({
          data: {
            notificationId: notifId,
            userId: updated.receiverId,
            isRead: false,
          },
        }).catch(() => {});
        broadcast('notifications', updated.receiverId, {
          id: notifId,
          title: `Missed ${isVideo ? 'video' : 'voice'} call`,
          body: `You missed a ${isVideo ? 'video' : 'voice'} call from ${callerName}`,
          category: 'call',
          type: 'call',
          actionUrl: `call/${callId}`,
          createdAt: new Date().toISOString(),
        });
      } catch (errNotif) {
        console.warn('[calls:patch:missed_notif]', errNotif);
      }
    }

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
