import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { canManageTenant } from '../auth/permissions';
import { broadcast } from '../ws/wsServer';

const router = Router();

function shapeTicket(t: any) {
  return {
    id: t.id,
    userId: t.userId,
    userName: t.user ? [t.user.firstName, t.user.lastName].filter(Boolean).join(' ') || 'Member' : 'Member',
    userEmail: t.user?.email || '',
    userAvatar: t.user?.avatarUrl || null,
    subject: t.subject || 'Support Request',
    category: t.category || 'General',
    status: t.status || 'open',
    priority: t.priority || 'normal',
    lastMessage: t.lastMessage || '',
    organizationId: t.organizationId || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

async function getAccessibleTicket(ticketId: string, userId: string, role?: string) {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    include: { user: true },
  });
  if (!ticket) return { ticket: null, forbidden: false };
  const isAdmin = canManageTenant(role);
  if (!isAdmin && ticket.userId !== userId) {
    return { ticket: null, forbidden: true };
  }
  return { ticket, forbidden: false };
}

/** GET /support — List tickets */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin';

    let rows: any[];
    if (isHqAdmin) {
      rows = await prisma.supportTicket.findMany({
        include: { user: true },
        orderBy: { updatedAt: 'desc' },
        take: 150,
      });
    } else {
      rows = await prisma.supportTicket.findMany({
        where: { userId: auth.userId },
        include: { user: true },
        orderBy: { updatedAt: 'desc' },
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
router.get('/:ticketId', requireAuth, async (req: Request, res: Response) => {
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
router.get('/:ticketId/messages', requireAuth, async (req: Request, res: Response) => {
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

    const messages = await prisma.message.findMany({
      where: { chatId: req.params.ticketId },
      include: { sender: true },
      orderBy: { createdAt: 'asc' },
    });

    const formatted = messages.map((m) => ({
      id: m.id,
      chatId: m.chatId,
      senderId: m.senderId,
      senderName: m.sender ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(' ') || m.sender.email : 'Support Admin',
      senderAvatar: m.sender?.avatarUrl || null,
      text: m.text || '',
      type: m.type || 'text',
      status: m.status,
      createdAt: m.createdAt,
    }));

    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    console.error('[support:messages]', err);
    res.status(500).json({ success: false, error: 'Failed to load ticket messages' });
  }
});

/** POST /support — Create support ticket */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { subject, category = 'General', priority = 'normal', message, text, initialMessage } = req.body;
    const firstText = (message || text || initialMessage || subject || 'Need support').trim();

    const ticketId = `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const messageId = crypto.randomUUID();

    const ticket = await prisma.supportTicket.create({
      data: {
        id: ticketId,
        userId: auth.userId,
        subject: subject || 'Support Request',
        category,
        status: 'open',
        priority,
        organizationId: auth.zoneId || null,
        lastMessage: firstText,
      },
    });

    // Create chat container and first message
    await prisma.chat.upsert({
      where: { id: ticketId },
      update: {},
      create: {
        id: ticketId,
        type: 'direct',
        title: `Support: ${subject || 'Ticket'}`,
        createdById: auth.userId,
        participants: {
          create: [{ userId: auth.userId }],
        },
      },
    });

    await prisma.message.create({
      data: {
        id: messageId,
        chatId: ticketId,
        senderId: auth.userId,
        type: 'text',
        text: firstText,
      },
    });

    broadcast('support', ticketId, { type: 'new_ticket', ticket });
    res.status(201).json({ success: true, data: shapeTicket(ticket) });
  } catch (err) {
    console.error('[support:create]', err);
    res.status(500).json({ success: false, error: 'Failed to create support ticket' });
  }
});

/** POST /support/:ticketId/messages — Reply to support ticket */
router.post('/:ticketId/messages', requireAuth, async (req: Request, res: Response) => {
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
    const text = (req.body.text || req.body.message || req.body.content || '').trim();
    if (!text) {
      res.status(400).json({ success: false, error: 'Message text is required' });
      return;
    }

    const messageId = crypto.randomUUID();
    const isAdmin = canManageTenant(auth.role);

    await prisma.message.create({
      data: {
        id: messageId,
        chatId: ticketId,
        senderId: auth.userId,
        type: 'text',
        text,
      },
    });

    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: {
        lastMessage: text,
        status: isAdmin ? 'in_progress' : 'open',
      },
    });

    const msgPayload = {
      id: messageId,
      chatId: ticketId,
      senderId: auth.userId,
      text,
      createdAt: new Date().toISOString(),
    };

    broadcast('support', ticketId, msgPayload);
    res.status(201).json({ success: true, data: msgPayload });
  } catch (err) {
    console.error('[support:reply]', err);
    res.status(500).json({ success: false, error: 'Failed to send support reply' });
  }
});

/** PATCH /support/:ticketId/status — Update ticket status */
router.patch('/:ticketId/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const { ticketId } = req.params;
    const auth = res.locals.auth;
    const { status } = req.body;

    if (!canManageTenant(auth.role)) {
      res.status(403).json({ success: false, error: 'Only admins can change ticket status' });
      return;
    }

    const updated = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status },
    });

    broadcast('support', ticketId, { type: 'status_change', ticketId, status });
    res.json({ success: true, data: shapeTicket(updated) });
  } catch (err) {
    console.error('[support:status]', err);
    res.status(500).json({ success: false, error: 'Failed to update ticket status' });
  }
});

export default router;
