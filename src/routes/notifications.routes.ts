import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function shapeNotification(n: any, isRead = false) {
  return {
    id: n.id,
    title: n.title,
    message: n.body,
    body: n.body,
    type: n.type || 'info',
    category: n.category || 'general',
    priority: n.priority || 'normal',
    actionUrl: n.actionUrl || null,
    organizationId: n.organizationId || null,
    senderId: n.senderId || null,
    isRead,
    createdAt: n.createdAt,
  };
}

/** GET /notifications — Get notifications for current user */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const userId = auth.userId as string;
    const effectiveOrgId = req.tenant?.effectiveZoneId || auth.zoneId || 'zone-001';

    // 1. Fetch direct deliveries for this user
    const directDeliveries = await prisma.notificationDelivery.findMany({
      where: { userId },
      include: { notification: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const directNotifIds = new Set(directDeliveries.map((d) => d.notificationId));

    // 2. Fetch organization broadcasts (global 'zone-001' or tenant-specific)
    const broadcasts = await prisma.notification.findMany({
      where: {
        OR: [
          { organizationId: effectiveOrgId },
          { organizationId: 'zone-001' },
          { organizationId: null },
        ],
        id: { notIn: Array.from(directNotifIds) },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const result: any[] = [];

    // Add direct deliveries
    for (const d of directDeliveries) {
      if (d.notification) {
        result.push(shapeNotification(d.notification, d.isRead));
      }
    }

    // Add broadcasts
    for (const b of broadcasts) {
      result.push(shapeNotification(b, false));
    }

    // Sort by createdAt descending
    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json({ success: true, count: result.length, data: result });
  } catch (err) {
    console.error('[notifications:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load notifications' });
  }
});

/** POST /notifications & POST /notifications/broadcast — Broadcast / Send notification */
const handleCreateNotification = async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { title, body, message, type = 'info', category = 'general', priority = 'normal', actionUrl, targetUserId, targetOrgId } = req.body;
    const text = (body || message || title || '').trim();
    if (!text) {
      return res.status(400).json({ success: false, error: 'Notification message is required' });
    }

    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const orgId = targetOrgId || req.tenant?.effectiveZoneId || 'zone-001';

    const notif = await prisma.notification.create({
      data: {
        id: notifId,
        title: title || 'Notification',
        body: text,
        type,
        category,
        priority,
        actionUrl: actionUrl || null,
        organizationId: orgId,
        senderId: auth.userId,
      },
    });

    // If targeted to a specific user, create a delivery record
    if (targetUserId) {
      await prisma.notificationDelivery.create({
        data: {
          notificationId: notifId,
          userId: targetUserId,
          isRead: false,
        },
      });
      broadcast('notifications', targetUserId, shapeNotification(notif, false));
    } else {
      // Broadcast to organization channel
      broadcast('notifications', orgId, shapeNotification(notif, false));
    }

    res.status(201).json({ success: true, data: shapeNotification(notif, false) });
  } catch (err) {
    console.error('[notifications:create]', err);
    res.status(500).json({ success: false, error: 'Failed to create notification' });
  }
};

router.post('/', requireAuth, requireTenantAdmin, handleCreateNotification);
router.post('/broadcast', requireAuth, requireTenantAdmin, handleCreateNotification);

/** POST /notifications/send — Dispatch peer-to-peer / system push & websocket notifications */
router.post('/send', requireAuth, async (req: Request, res: Response) => {
  try {
    const { recipientIds, title, body, data } = req.body;
    const userIds: string[] = Array.isArray(recipientIds) ? recipientIds : [recipientIds].filter(Boolean);
    if (!userIds.length) {
      return res.status(400).json({ success: false, error: 'recipientIds are required' });
    }

    // 1. Broadcast real-time websocket event to each recipient
    for (const uid of userIds) {
      broadcast('notifications', uid, {
        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title,
        body,
        data,
        createdAt: new Date().toISOString(),
      });
      if (data?.type === 'call' || data?.screen === 'Call' || data?.callId) {
        broadcast('calls', uid, {
          type: 'incoming_call',
          call: {
            id: data?.callId,
            callerName: data?.senderName || title,
            callerAvatar: data?.senderAvatar,
            type: data?.callType || 'voice',
            chatId: data?.chatId,
            roomId: data?.callId,
          },
        });
      }
    }

    // 2. Fetch Expo push tokens from settings table and dispatch to Expo Push API
    try {
      const metaKeys = userIds.map((id) => `profile_meta_${id}`);
      const settings = await prisma.setting.findMany({
        where: { key: { in: metaKeys } },
      });

      const pushMessages: any[] = [];
      for (const s of settings) {
        const val: any = s.value;
        const token = val?.expoPushToken || val?.expo_push_token;
        if (token && typeof token === 'string' && token.startsWith('ExponentPushToken')) {
          pushMessages.push({
            to: token,
            sound: 'default',
            title: title || 'New Notification',
            body: body || '',
            data: data || {},
          });
        }
      }

      if (pushMessages.length > 0) {
        fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Accept-encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(pushMessages),
        }).catch((err) => console.warn('[ExpoPush] Dispatch failed:', err));
      }
    } catch (pushErr) {
      console.warn('[notifications:send:expo]', pushErr);
    }

    res.json({ success: true, count: userIds.length });
  } catch (err) {
    console.error('[notifications:send]', err);
    res.status(500).json({ success: false, error: 'Failed to send notifications' });
  }
});

/** POST /notifications/mark-read — Mark a single notification as read */
router.post('/mark-read', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const notifId = req.body.notificationId || req.body.id;
    if (!notifId) {
      return res.status(400).json({ success: false, error: 'notificationId is required' });
    }

    await prisma.notificationDelivery.upsert({
      where: { notificationId_userId: { notificationId: notifId, userId } },
      create: { notificationId: notifId, userId, isRead: true, readAt: new Date() },
      update: { isRead: true, readAt: new Date() },
    });

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    console.error('[notifications/mark-read]', err);
    res.status(500).json({ success: false, error: 'Failed to mark notification read' });
  }
});

/** PATCH /notifications/:id — Mark specific notification as read/unread */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const notifId = req.params.id;
    const isRead = req.body.is_read !== undefined ? Boolean(req.body.is_read) : true;

    await prisma.notificationDelivery.upsert({
      where: { notificationId_userId: { notificationId: notifId, userId } },
      create: { notificationId: notifId, userId, isRead, readAt: isRead ? new Date() : null },
      update: { isRead, readAt: isRead ? new Date() : null },
    });

    res.json({ success: true, message: `Notification marked as ${isRead ? 'read' : 'unread'}` });
  } catch (err) {
    console.error('[notifications:PATCH:id]', err);
    res.status(500).json({ success: false, error: 'Failed to update notification' });
  }
});

/** POST /notifications/mark-all-read & PATCH /notifications/read-all */
const markAllRead = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    await prisma.notificationDelivery.updateMany({
      where: { userId },
      data: { isRead: true, readAt: new Date() },
    });
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[notifications/mark-all-read]', err);
    res.status(500).json({ success: false, error: 'Failed to mark all read' });
  }
};
router.post('/mark-all-read', requireAuth, markAllRead);
router.post('/read-all', requireAuth, markAllRead);
router.patch('/read-all', requireAuth, markAllRead);

/** DELETE /notifications/:id */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const isHqAdmin = res.locals.auth?.role === 'hq_admin' || res.locals.auth?.role === 'admin';
    const { id } = req.params;

    if (isHqAdmin && req.query.permanent === 'true') {
      await prisma.notification.deleteMany({ where: { id } });
      return res.json({ success: true, message: 'Notification deleted permanently' });
    }

    // Dismiss for user via Delivery marked read
    await prisma.notificationDelivery.upsert({
      where: { notificationId_userId: { notificationId: id, userId } },
      create: { notificationId: id, userId, isRead: true, readAt: new Date() },
      update: { isRead: true, readAt: new Date() },
    });

    res.json({ success: true, message: 'Notification dismissed' });
  } catch (err) {
    console.error('[notifications/delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete notification' });
  }
});

export default router;
