import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';

export const upcomingEventsRouter = Router();

upcomingEventsRouter.get('/', requireAuth, async (req: any, res: any) => {
  try {
    const rows = await prisma.program.findMany({ orderBy: { date: 'desc' } });
    let events = rows.map(mergeRawRow);
    const effectiveZoneId = req.tenant?.effectiveZoneId;
    if (effectiveZoneId && effectiveZoneId !== 'all') {
      const target = String(effectiveZoneId).toLowerCase();
      const withoutHyphen = target.replace(/-/g, '');
      const withHyphen = target.includes('-') ? target : target.replace(/^zone(\d+)$/, 'zone-$1');
      events = events.filter((e: any) => {
        const ez = (e.zoneId || e.zone_id || '').toLowerCase();
        return e.isGlobal === true || !e.zoneId || ez === target || ez === withHyphen || ez.replace(/-/g, '') === withoutHyphen;
      });
    }
    res.json({ success: true, count: events.length, data: events });
  } catch (err) {
    console.error('[upcomingEvents:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch upcoming events' });
  }
});

upcomingEventsRouter.get('/:id', requireAuth, async (req: any, res: any) => {
  try {
    const row = await prisma.program.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ success: false, error: 'Event not found' });
    res.json({ success: true, data: mergeRawRow(row) });
  } catch (err) {
    console.error('[upcomingEvents:GET_BY_ID]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch event' });
  }
});

upcomingEventsRouter.post('/', requireAuth, async (req: any, res: any) => {
  try {
    const body = req.body || {};
    const id = body.id || `upcoming-${Date.now()}`;
    const now = new Date().toISOString();
    const tenant = req.tenant;
    const requestedZoneId = body.zoneId ? String(body.zoneId) : null;
    if (!tenant?.isHQAdmin && requestedZoneId && requestedZoneId !== tenant?.effectiveZoneId) {
      return res.status(403).json({ success: false, error: 'Forbidden: Event is outside your tenant scope' });
    }
    const rawData = { ...body, id, createdAt: body.createdAt || now, updatedAt: now, showInCarousel: body.showInCarousel !== false };
    const record = await prisma.program.create({
      data: {
        id,
        name: body.title || body.name || 'Untitled Event',
        date: body.date || now.split('T')[0],
        category: body.type || 'event',
        organizationId: (tenant?.isHQAdmin ? requestedZoneId : tenant?.effectiveZoneId) || 'zone-001',
        location: body.location || null,
        rawData,
      },
    });
    res.json({ success: true, data: mergeRawRow(record) });
  } catch (err) {
    console.error('[upcomingEvents:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create event' });
  }
});

upcomingEventsRouter.patch('/:id', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const now = new Date().toISOString();
    const existing = await prisma.program.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Event not found' });
    const tenant = req.tenant;
    const existingZoneId = existing.organizationId || (existing.rawData as any)?.zoneId || null;
    if (!tenant?.isHQAdmin && existingZoneId !== tenant?.effectiveZoneId) return res.status(403).json({ success: false, error: 'Forbidden' });
    if (!tenant?.isHQAdmin && body.zoneId && body.zoneId !== tenant?.effectiveZoneId) return res.status(403).json({ success: false, error: 'Forbidden' });
    const mergedData = { ...(existing.rawData as any || {}), ...body, id, updatedAt: now };
    const updateData: any = { rawData: mergedData };
    if (body.title !== undefined || body.name !== undefined) updateData.name = body.title || body.name;
    if (body.date !== undefined) updateData.date = body.date;
    if (body.category !== undefined || body.type !== undefined) updateData.category = body.category || body.type;
    if (body.zoneId !== undefined && tenant?.isHQAdmin) updateData.organizationId = body.zoneId;
    if (body.location !== undefined) updateData.location = body.location;
    const updated = await prisma.program.update({ where: { id }, data: updateData });
    res.json({ success: true, data: mergeRawRow(updated) });
  } catch (err) {
    console.error('[upcomingEvents:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update event' });
  }
});

upcomingEventsRouter.delete('/:id', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const tenant = req.tenant;
    if (!tenant?.isHQAdmin) {
      const existing = await prisma.program.findUnique({ where: { id } });
      const existingZoneId = existing?.organizationId || (existing?.rawData as any)?.zoneId || null;
      if (!existing || existingZoneId !== tenant?.effectiveZoneId) return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    await prisma.program.delete({ where: { id } });
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (err) {
    console.error('[upcomingEvents:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete event' });
  }
});
