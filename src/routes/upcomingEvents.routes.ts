import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

export const upcomingEventsRouter = Router();

upcomingEventsRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const effectiveZoneId = req.tenant?.effectiveZoneId || 'zone-001';

    const events = await prisma.program.findMany({
      where: {
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
        ],
      },
      orderBy: { date: 'desc' },
    });

    res.json({ success: true, count: events.length, data: events });
  } catch (err) {
    console.error('[upcomingEvents:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch upcoming events' });
  }
});

upcomingEventsRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const row = await prisma.program.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ success: false, error: 'Event not found' });
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('[upcomingEvents:GET_BY_ID]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch event' });
  }
});

upcomingEventsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const id = body.id || `upcoming-${Date.now()}`;
    const tenant = req.tenant;
    const requestedZoneId = body.zoneId ? String(body.zoneId) : null;
    const orgId = (tenant?.isHQAdmin ? requestedZoneId : tenant?.effectiveZoneId) || 'zone-001';

    const record = await prisma.program.create({
      data: {
        id,
        name: body.title || body.name || 'Untitled Event',
        date: body.date || new Date().toISOString().split('T')[0],
        category: body.type || body.category || 'event',
        organizationId: orgId,
        location: body.location || null,
        bannerImage: body.bannerImage || null,
      },
    });

    res.status(201).json({ success: true, data: record });
  } catch (err) {
    console.error('[upcomingEvents:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create event' });
  }
});

upcomingEventsRouter.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const existing = await prisma.program.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Event not found' });

    const updateData: any = {};
    if (body.title !== undefined || body.name !== undefined) updateData.name = body.title || body.name;
    if (body.date !== undefined) updateData.date = body.date;
    if (body.category !== undefined || body.type !== undefined) updateData.category = body.category || body.type;
    if (body.location !== undefined) updateData.location = body.location;
    if (body.bannerImage !== undefined) updateData.bannerImage = body.bannerImage;

    const updated = await prisma.program.update({ where: { id }, data: updateData });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[upcomingEvents:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update event' });
  }
});

upcomingEventsRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.program.delete({ where: { id } });
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (err) {
    console.error('[upcomingEvents:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete event' });
  }
});

export default upcomingEventsRouter;
