import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';
import { broadcast } from '../ws/wsServer';
import { canManageTenant, isHQRole } from '../auth/permissions';

const router = Router();

function isSupportAdmin(role: unknown): boolean {
  return canManageTenant(role);
}

async function getAccessibleTicket(ticketId: string, userId: string, role: unknown) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { ticket: null, forbidden: false };
  if (isSupportAdmin(role) || ticket.userId === userId) return { ticket, forbidden: false };
  return { ticket: null, forbidden: true };
}

function shapeTicket(row: any) {
  const merged = mergeRawRow(row);
  const raw = (row.rawData && typeof row.rawData === 'object') ? (row.rawData as Record<string, any>) : {};

  let lastMessageText = row.lastMessage || raw.lastMessage || raw.last_message || 'No messages yet';
  if (typeof lastMessageText === 'object' && lastMessageText && 'text' in (lastMessageText as any)) {
    lastMessageText = (lastMessageText as any).text;
  }

  let lastTimestamp = row.lastTimestamp ? new Date(row.lastTimestamp).toISOString() : (raw.lastTimestamp || raw.updatedAt || new Date().toISOString());

  return {
    ...merged,
    id: row.id,
    ticketId: row.id,
    userId: row.userId || raw.userId || 'singer',
    userName: row.userName || raw.userName || raw.user_name || 'Member',
    userEmail: row.userEmail || raw.userEmail || '',
    subject: row.subject || raw.subject || 'Support Inquiry',
    category: row.category || raw.category || 'general',
    status: row.status || raw.status || 'open',
    priority: row.priority || raw.priority || 'normal',
    zoneId: row.zoneId || raw.zoneId || null,
    lastMessage: typeof lastMessageText === 'string' ? lastMessageText : 'No messages yet',
    lastTimestamp,
    unreadByAdmin: row.unreadByAdmin || 0,
    unreadByUser: row.unreadByUser || 0,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
  };
}

/** GET /support — List support tickets */
router.get('/', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = isHQRole(auth.role);

    const { zoneId } = req.query;
    const effectiveZoneId = (zoneId && zoneId !== 'all') ? String(zoneId) : null;

    let rows: any[];
    if (isHqAdmin) {
      if (effectiveZoneId) {
        const withoutHyphen = effectiveZoneId.replace(/-/g, '').toLowerCase();
        const withHyphen = effectiveZoneId.includes('-') ? effectiveZoneId.toLowerCase() : effectiveZoneId.toLowerCase().replace(/^zone(\d+)$/, 'zone-$1');

        rows = await prisma.$queryRawUnsafe<any[]>(
          `SELECT * FROM support_tickets
           WHERE lower(replace(COALESCE(zone_id, ''), '-', '')) = $1
              OR lower(COALESCE(zone_id, '')) = $2
           ORDER BY last_timestamp DESC
           LIMIT 150`,
          withoutHyphen,
          withHyphen,
        );
      } else {
        rows = await prisma.supportTicket.findMany({
          orderBy: { lastTimestamp: 'desc' },
          take: 150,
        });
      }
    } else {
      rows = await prisma.supportTicket.findMany({
        where: { userId: auth.userId },
        orderBy: { lastTimestamp: 'desc' },
        take: 50,
      });
    }

    res.json({ success: true, count: rows.length, data: rows.map(shapeTicket) });
  } catch (err) {
    console.error('[support:list]', err);
    res.status(500).json({ success: false, error: 'Failed to load support tickets' });
  }
});

/** GET /support/:ticketId — Get single ticket */
router.get('/:ticketId', requireAuth, async (req, res) => {
  try {
    const { ticket, forbidden } = await getAccessibleTicket(
      req.params.ticketId,
      res.locals.auth.userId,
      res.locals.auth.role,
    );
    if (forbidden) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Support ticket not found' });
      return;
    }
    res.json({ success: true, data: shapeTicket(ticket) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load support ticket' });
  }
});

/** GET /support/:ticketId/messages — Get ticket messages */
router.get('/:ticketId/messages', requireAuth, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { ticket, forbidden } = await getAccessibleTicket(
      ticketId,
      res.locals.auth.userId,
      res.locals.auth.role,
    );
    if (forbidden) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Support ticket not found' });
      return;
    }
    const messageRows = await prisma.message.findMany({
      where: { chatId: ticketId },
      orderBy: { id: 'asc' },
    });

    const data = messageRows.map((m) => {
      const merged = mergeRawRow(m);
      const raw = (m.rawData && typeof m.rawData === 'object') ? (m.rawData as Record<string, any>) : {};
      return {
        ...merged,
        id: m.id,
        ticketId: m.chatId,
        senderId: m.senderId,
        senderName: m.senderName || raw.senderName || 'Support User',
        senderType: raw.senderType || 'user',
        text: m.text || raw.text || '',
        message: m.text || raw.text || '',
        timestamp: raw.createdAt || new Date().toISOString(),
      };
    });

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[support:messages:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load support messages' });
  }
});

/** POST /support — Create new support ticket */
router.post('/', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const { subject, category = 'general', priority = 'normal', message, initialMessage } = req.body;
    const firstText = message || initialMessage || subject || 'Need assistance with rehearsal hub';

    const ticketId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const now = new Date();

    const userProf = await prisma.profile.findUnique({ where: { id: auth.userId } });
    const rawP = (userProf?.rawData && typeof userProf.rawData === 'object') ? (userProf.rawData as Record<string, any>) : {};
    const userName = [userProf?.firstName, userProf?.lastName].filter(Boolean).join(' ') || rawP.first_name || auth.email || 'Singer';
    const userEmail = userProf?.email || rawP.email || auth.email || '';

    const ticketRaw = {
      id: ticketId,
      userId: auth.userId,
      userName,
      userEmail,
      subject: subject || 'Support Request',
      category,
      status: 'open',
      priority,
      zoneId: auth.zoneId || null,
      lastMessage: firstText,
      lastTimestamp: now.toISOString(),
      createdAt: now.toISOString(),
    };

    await prisma.supportTicket.create({
      data: {
        id: ticketId,
        userId: auth.userId,
        userName,
        userEmail,
        subject: subject || 'Support Request',
        category,
        status: 'open',
        priority,
        zoneId: auth.zoneId || null,
        lastMessage: firstText,
        lastTimestamp: now,
        unreadByAdmin: 1,
        createdAt: now,
        updatedAt: now,
        rawData: ticketRaw,
      },
    });

    // Ensure chat exists or create support message
    await prisma.chat.upsert({
      where: { id: ticketId },
      update: {},
      create: {
        id: ticketId,
        type: 'support',
        createdBy: auth.userId,
        participants: [auth.userId],
      },
    });

    await prisma.message.create({
      data: {
        id: messageId,
        chatId: ticketId,
        senderId: auth.userId,
        senderName: userName,
        type: 'support',
        text: firstText,
        rawData: { id: messageId, ticketId, senderId: auth.userId, senderName: userName, text: firstText, senderType: 'user', createdAt: now.toISOString() },
      },
    });

    broadcast('support', ticketId, { type: 'new_ticket', ticket: ticketRaw });
    res.status(201).json({ success: true, data: ticketRaw });
  } catch (err) {
    console.error('[support:create]', err);
    res.status(500).json({ success: false, error: 'Failed to create support ticket' });
  }
});

/** POST /support/:ticketId/messages — Reply to support ticket */
router.post('/:ticketId/messages', requireAuth, async (req: any, res) => {
  try {
    const { ticketId } = req.params;
    const auth = res.locals.auth;
    const { ticket, forbidden } = await getAccessibleTicket(ticketId, auth.userId, auth.role);
    if (forbidden) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    if (!ticket) {
      res.status(404).json({ success: false, error: 'Support ticket not found' });
      return;
    }
    const text = req.body.text?.trim() || req.body.message?.trim() || req.body.content?.trim();

    if (!text) {
      res.status(400).json({ success: false, error: 'Message text is required' });
      return;
    }

    const messageId = crypto.randomUUID();
    const now = new Date();
    const isAdmin = canManageTenant(auth.role);
    const senderType = isAdmin ? 'admin' : 'user';
    const senderName = req.body.senderName || (isAdmin ? 'HQ Support Admin' : 'Member');

    const msgPayload = {
      id: messageId,
      ticketId,
      senderId: auth.userId,
      senderName,
      senderType,
      text,
      message: text,
      timestamp: now.toISOString(),
      createdAt: now.toISOString(),
    };

    await prisma.chat.upsert({
      where: { id: ticketId },
      update: {},
      create: {
        id: ticketId,
        type: 'support',
        createdBy: auth.userId,
        participants: [auth.userId],
      },
    });

    await prisma.message.create({
      data: {
        id: messageId,
        chatId: ticketId,
        senderId: auth.userId,
        senderName,
        type: 'support',
        text,
        rawData: msgPayload,
      },
    });

    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        lastMessage: text,
        lastTimestamp: now,
        updatedAt: now,
        status: isAdmin ? 'in_progress' : 'open',
      },
    });

    broadcast('support', ticketId, msgPayload);
    res.status(201).json({ success: true, data: msgPayload });
  } catch (err) {
    console.error('[support:reply]', err);
    res.status(500).json({ success: false, error: 'Failed to send support reply' });
  }
});

/** PATCH /support/:ticketId/status — Update ticket status */
router.patch('/:ticketId/status', requireAuth, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const auth = res.locals.auth;
    const { status } = req.body;
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed'];

    if (!validStatuses.includes(status)) {
      res.status(400).json({ success: false, error: 'Invalid status' });
      return;
    }

    const { ticket, forbidden } = await getAccessibleTicket(ticketId, auth.userId, auth.role);
    if (forbidden || !ticket || !isSupportAdmin(auth.role)) {
      res.status(forbidden ? 403 : 404).json({ success: false, error: forbidden ? 'Forbidden' : 'Support ticket not found' });
      return;
    }

    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        status,
        updatedAt: new Date(),
      },
    });

    res.json({ success: true, message: `Ticket status updated to ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update ticket status' });
  }
});

/** DELETE /support/:ticketId — Delete support ticket */
router.delete('/:ticketId', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const { ticketId } = req.params;
    await prisma.message.deleteMany({ where: { chatId: ticketId } });
    await prisma.supportTicket.delete({ where: { id: ticketId } });

    res.json({ success: true, message: 'Support ticket deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete support ticket' });
  }
});

export default router;
