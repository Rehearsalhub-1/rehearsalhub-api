import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';
import { broadcast } from '../ws/wsServer';

const router = Router();

/** GET /notifications — per-user read state, audience-scoped, and admin feeds */
router.get('/', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const userId = auth.userId as string;
    const isAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'zone_admin' || req.query.admin === 'true';

    const [notifRows, groupRows] = await Promise.all([
      prisma.notification.findMany({
        orderBy: { createdAt: 'desc' },
        take: 150,
      }),
      prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM user_groups WHERE raw_data->>'user_id' = $1 OR raw_data->>'userId' = $1`,
        userId,
      ).catch(() => []),
    ]);

    const groupNames = new Set<string>();
    for (const g of groupRows) {
      const m = mergeRawRow(g);
      const name = (m.group_name || m.groupName) as string | undefined;
      if (name) groupNames.add(name);
    }

    const data = notifRows
      .map((row) => {
        const merged = mergeRawRow(row);
        const raw = (row.rawData && typeof row.rawData === 'object') ? (row.rawData as Record<string, any>) : {};

        const dismissedBy = (raw.dismissedBy && typeof raw.dismissedBy === 'object') ? raw.dismissedBy : {};
        if (dismissedBy[userId]) return null;

        const audience =
          (row.targetAudience as string | undefined) ||
          (raw.target_audience as string | undefined) ||
          (raw.targetAudience as string | undefined) ||
          'all';
        const targetUser =
          row.targetUserId ||
          (raw.target_user_id as string | undefined) ||
          (raw.targetUserId as string | undefined);
        const targetGroup =
          (raw.target_group as string | undefined) || (raw.targetGroup as string | undefined);

        const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
        const isZoneAdmin = auth.role === 'zone_admin' || isHqAdmin;
        const userZone = auth.zoneId as string | undefined;

        // Strict visibility resolution
        let visible = false;

        if (targetUser) {
          if (targetUser === userId) {
            visible = true;
          } else if (req.query.admin === 'true' && isHqAdmin) {
            visible = true;
          }
        } else if (audience === 'hq_admin') {
          visible = isHqAdmin;
        } else if (audience === 'zone_admin') {
          visible = isZoneAdmin;
        } else if (audience === 'group' && targetGroup) {
          visible = groupNames.has(targetGroup) || isHqAdmin;
        } else if (audience === 'all' || audience === 'broadcast') {
          const notifZone = row.zoneId || (raw.zoneId as string) || (raw.zone_id as string);
          if (!notifZone || notifZone === 'all' || notifZone === 'global' || isHqAdmin) {
            visible = true;
          } else if (userZone && notifZone) {
            const uNorm = userZone.replace(/-/g, '').toLowerCase();
            const nNorm = notifZone.replace(/-/g, '').toLowerCase();
            if (uNorm === nNorm || userZone.toLowerCase() === notifZone.toLowerCase()) {
              visible = true;
            }
          }
        } else if (isAdmin) {
          visible = true;
        }

        if (!visible) return null;

        const title = row.title || (raw.title as string) || (merged.title as string) || 'Broadcast Notification';
        const message = row.message || (raw.message as string) || (raw.body as string) || (raw.text as string) || (merged.message as string) || (merged.body as string) || '';
        const body = (raw.body as string) || message;
        const category = row.category || (raw.category as string) || (merged.category as string) || 'general';
        const priority = row.priority || (raw.priority as string) || (merged.priority as string) || 'normal';
        const senderName = (raw.sender_name as string) || (raw.senderName as string) || (raw.sentBy as string) || (merged.sender_name as string) || (merged.senderName as string) || 'HQ Administrator';
        const sentBy = senderName;
        const createdAt = row.createdAt || (raw.created_at as string) || (raw.createdAt as string) || (merged.created_at as string) || new Date().toISOString();
        const readBy = (raw.readBy && typeof raw.readBy === 'object') ? raw.readBy : {};
        const isRead = Boolean(readBy[userId])
          || (row as any).isRead === true
          || (raw.is_read === true && (!targetUser || targetUser === userId))
          || (raw.isRead === true && (!targetUser || targetUser === userId));

        return {
          ...merged,
          id: row.id,
          title,
          message,
          body,
          category,
          priority,
          senderName,
          sentBy,
          targetAudience: audience,
          target_audience: audience,
          createdAt,
          created_at: createdAt,
          sentAt: createdAt,
          is_read: isRead,
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[notifications:GET]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /notifications/:id — get single notification */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const row = await prisma.notification.findUnique({ where: { id } });
    if (!row) {
      res.status(404).json({ success: false, error: 'Notification not found' });
      return;
    }
    const merged = mergeRawRow(row);
    const raw = (row.rawData && typeof row.rawData === 'object') ? (row.rawData as Record<string, unknown>) : {};
    const title = row.title || (raw.title as string) || (merged.title as string) || 'Broadcast Notification';
    const message = row.message || (raw.message as string) || (raw.body as string) || (raw.text as string) || (merged.message as string) || '';
    const body = (raw.body as string) || message;
    const category = row.category || (raw.category as string) || 'general';
    const priority = row.priority || (raw.priority as string) || 'normal';
    const senderName = (raw.sender_name as string) || (raw.senderName as string) || (raw.sentBy as string) || 'HQ Administrator';

    res.json({
      success: true,
      data: {
        ...merged,
        id: row.id,
        title,
        message,
        body,
        category,
        priority,
        senderName,
        sentBy: senderName,
      },
    });
  } catch (err) {
    console.error('[notifications/:id GET]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch notification' });
  }
});

/** Handler for creating broadcast notification (CREATE) */
const createBroadcastHandler = async (req: any, res: any) => {
  try {
    const auth = res.locals.auth;
    const body = req.body || {};
    const { title, message, body: altBody, type, category, priority, targetAudience, targetZoneId, targetUserId, senderId, senderName, actionUrl } = body;

    const notifTitle = (title || '').trim();
    const notifMessage = (message || altBody || '').trim();

    if (!notifTitle || !notifMessage) {
      res.status(400).json({ success: false, error: 'Title and message are required' });
      return;
    }

    const id = body.id || `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const sName = senderName || auth.name || auth.email || 'HQ Administrator';

    const rawData = {
      ...body,
      id,
      title: notifTitle,
      message: notifMessage,
      body: notifMessage,
      type: type || 'info',
      category: category || 'general',
      priority: priority || 'normal',
      target_audience: targetAudience || 'all',
      target_zone_id: targetZoneId || null,
      target_user_id: targetUserId || null,
      sender_id: senderId || auth.userId,
      sender_name: sName,
      sentBy: sName,
      created_at: now,
      createdAt: now,
      sentAt: now,
      is_read: false,
    };

    const newRecord = await prisma.notification.create({
      data: {
        id,
        title: notifTitle,
        message: notifMessage,
        type: type || 'info',
        category: category || 'general',
        priority: priority || 'normal',
        targetAudience: targetAudience || 'all',
        targetUserId: targetUserId || null,
        zoneId: targetZoneId || null,
        senderId: senderId || auth.userId,
        actionUrl: actionUrl || null,
        isRead: false,
        createdAt: now,
        rawData,
      },
    });

    broadcast('notifications', 'all', { notificationId: id });

    res.status(201).json({
      success: true,
      message: 'Broadcast notification published successfully',
      data: mergeRawRow(newRecord),
    });
  } catch (err) {
    console.error('[notifications:CREATE]', err);
    res.status(500).json({ success: false, error: 'Failed to create broadcast notification' });
  }
};

/** POST /notifications & POST /notifications/broadcast (CREATE) */
router.post('/', requireAuth, requireTenantAdmin, createBroadcastHandler);
router.post('/broadcast', requireAuth, requireTenantAdmin, createBroadcastHandler);

/** PATCH /notifications/:id — update read state or update notification fields (UPDATE) */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const notifId = req.params.id;
    const { is_read, title, message, body, priority, category, targetAudience, targetZoneId } = req.body;

    // 1. Read receipt toggle
    if (is_read !== undefined) {
      try {
        const notifRecord = await prisma.notification.findUnique({ where: { id: notifId } });
        if (notifRecord) {
          const raw = (notifRecord.rawData && typeof notifRecord.rawData === 'object') ? { ...(notifRecord.rawData as any) } : {};
          const readBy = { ...(raw.readBy || {}) };
          if (is_read) {
            readBy[userId] = new Date().toISOString();
          } else {
            delete readBy[userId];
          }
          raw.readBy = readBy;
          if (notifRecord.targetUserId === userId || raw.target_user_id === userId || raw.targetUserId === userId) {
            raw.is_read = is_read;
            raw.isRead = is_read;
          }
          await prisma.notification.update({
            where: { id: notifId },
            data: { isRead: Boolean(is_read), rawData: raw },
          });
        }
      } catch {
        // non-blocking
      }

      broadcast('notification', notifId, { id: notifId, is_read });
      res.json({ success: true, message: 'Notification read status updated' });
      return;
    }

    // 2. Admin field update (title, message, category, priority, etc.)
    if (title !== undefined || message !== undefined || body !== undefined || category !== undefined || priority !== undefined || targetAudience !== undefined || targetZoneId !== undefined) {
      let allowed = false;
      requireTenantAdmin(req, res, () => { allowed = true; });
      if (!allowed) return;

      const existingRow = await prisma.notification.findUnique({ where: { id: notifId } });
      if (existingRow) {
        const oldRaw = (existingRow.rawData && typeof existingRow.rawData === 'object') ? existingRow.rawData as Record<string, any> : {};
        const updatedRaw = {
          ...oldRaw,
          ...(title !== undefined ? { title: title.trim() } : {}),
          ...(message !== undefined ? { message: message.trim(), body: message.trim() } : {}),
          ...(body !== undefined ? { body: body.trim(), message: body.trim() } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(targetAudience !== undefined ? { target_audience: targetAudience } : {}),
          ...(targetZoneId !== undefined ? { target_zone_id: targetZoneId } : {}),
          updated_at: new Date().toISOString(),
        };

        await prisma.notification.update({
          where: { id: notifId },
          data: {
            ...(title !== undefined ? { title: title.trim() } : {}),
            ...(message !== undefined ? { message: message.trim() } : {}),
            ...(category !== undefined ? { category } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(targetAudience !== undefined ? { targetAudience } : {}),
            ...(targetZoneId !== undefined ? { zoneId: targetZoneId } : {}),
            rawData: updatedRaw,
          },
        });
      }
    }

    res.json({ success: true, message: 'Notification updated successfully' });
  } catch (err) {
    console.error('[notifications/:id PATCH]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** PUT /notifications/:id (UPDATE) */
router.put('/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const notifId = req.params.id;
    const { title, message, body, priority, category, targetAudience, targetZoneId } = req.body;

    const existingRow = await prisma.notification.findUnique({ where: { id: notifId } });
    if (!existingRow) {
      res.status(404).json({ success: false, error: 'Notification not found' });
      return;
    }

    const oldRaw = (existingRow.rawData && typeof existingRow.rawData === 'object') ? existingRow.rawData as Record<string, any> : {};
    const updatedRaw = {
      ...oldRaw,
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(message !== undefined ? { message: message.trim(), body: message.trim() } : {}),
      ...(body !== undefined ? { body: body.trim(), message: body.trim() } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(targetAudience !== undefined ? { target_audience: targetAudience } : {}),
      ...(targetZoneId !== undefined ? { target_zone_id: targetZoneId } : {}),
      updated_at: new Date().toISOString(),
    };

    await prisma.notification.update({
      where: { id: notifId },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(message !== undefined ? { message: message.trim() } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(targetAudience !== undefined ? { targetAudience } : {}),
        ...(targetZoneId !== undefined ? { zoneId: targetZoneId } : {}),
        rawData: updatedRaw,
      },
    });

    res.json({ success: true, message: 'Notification updated successfully' });
  } catch (err) {
    console.error('[notifications/:id PUT]', err);
    res.status(500).json({ success: false, error: 'Failed to update notification' });
  }
});

/** PATCH /notifications/read-all — mark all visible notifications read for this user */
router.patch('/read-all', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    await prisma.notification.updateMany({
      where: { targetUserId: userId },
      data: { isRead: true },
    });
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[notifications/read-all PATCH]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.post('/read-all', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    await prisma.notification.updateMany({
      where: { targetUserId: userId },
      data: { isRead: true },
    });
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[notifications/read-all POST]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** POST /notifications/mark-read — mark a single notification read (alias) */
router.post('/mark-read', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const notifId = req.body.notificationId || req.body.id;
    if (!notifId) {
      res.status(400).json({ success: false, error: 'notificationId is required' });
      return;
    }

    const notif = await prisma.notification.findUnique({ where: { id: notifId } });
    if (notif) {
      const raw = (notif.rawData && typeof notif.rawData === 'object') ? { ...(notif.rawData as any) } : {};
      const readBy = { ...(raw.readBy || {}) };
      readBy[userId] = new Date().toISOString();
      raw.readBy = readBy;
      await prisma.notification.update({
        where: { id: notifId },
        data: { isRead: true, rawData: raw },
      });
    }

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    console.error('[notifications/mark-read POST]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** POST /notifications/mark-all-read — mark all notifications read (alias) */
router.post('/mark-all-read', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    await prisma.notification.updateMany({
      where: { targetUserId: userId },
      data: { isRead: true },
    });
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[notifications/mark-all-read POST]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** POST /notifications/send — Expo push broadcast */
router.post('/send', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { recipientIds, title, body, data } = req.body;
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      res.status(400).json({ success: false, error: 'recipientIds array is required' });
      return;
    }

    const targetProfiles = await prisma.profile.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, rawData: true },
    });

    const expoTokens: string[] = [];
    for (const p of targetProfiles) {
      const token = (p.rawData as any)?.expo_push_token || (p.rawData as any)?.expoPushToken;
      if (token && typeof token === 'string' && token.startsWith('ExponentPushToken')) {
        expoTokens.push(token);
      }
    }

    if (expoTokens.length === 0) {
      res.json({ success: true, message: 'No valid push tokens found for recipients.' });
      return;
    }

    const payload = expoTokens.map((token) => ({
      to: token,
      sound: 'default',
      title,
      body,
      data: data || {},
      channelId: 'default',
      priority: 'high',
    }));

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('[notifications/send] Expo Push API Error:', errText);
    }

    res.json({ success: true, message: 'Push notifications queued to Expo.' });
  } catch (err) {
    console.error('[notifications/send]', err);
    res.status(500).json({ success: false, error: 'Failed to send push notifications.' });
  }
});

/** DELETE /notifications/:id — delete a notification (HQ admin) or dismiss for user */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const isHqAdmin = res.locals.auth?.role === 'hq_admin' || res.locals.auth?.role === 'admin';
    const { id } = req.params;

    if (isHqAdmin && req.query.permanent === 'true') {
      await prisma.notification.deleteMany({ where: { id } });
      res.json({ success: true, message: 'Notification deleted permanently' });
      return;
    }

    // Mark as read / dismissed on notification record
    const notif = await prisma.notification.findUnique({ where: { id } });
    if (notif) {
      const raw = (notif.rawData && typeof notif.rawData === 'object') ? { ...(notif.rawData as any) } : {};
      const dismissedBy = { ...(raw.dismissedBy || {}) };
      dismissedBy[userId] = new Date().toISOString();
      raw.dismissedBy = dismissedBy;
      await prisma.notification.update({
        where: { id },
        data: { isRead: true, rawData: raw },
      });
    }

    res.json({ success: true, message: 'Notification dismissed' });
  } catch (err) {
    console.error('[notifications/:id DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to dismiss notification' });
  }
});

export default router;
