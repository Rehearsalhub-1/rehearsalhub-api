import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

function shapeSchedule(p: any) {
  return {
    id: p.id,
    name: p.name,
    date: p.date,
    category: p.category || 'schedule',
    status: p.status || 'pre-rehearsal',
    organizationId: p.organizationId,
    location: p.location || null,
    bannerImage: p.bannerImage || null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const effectiveZoneId = req.tenant?.effectiveZoneId || 'zone-001';

    const programs = await prisma.program.findMany({
      where: {
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, count: programs.length, data: programs.map(shapeSchedule) });
  } catch (err) {
    console.error('[schedule:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load schedules' });
  }
});

router.get('/:scheduleId', requireAuth, async (req: Request, res: Response) => {
  try {
    const row = await prisma.program.findUnique({
      where: { id: req.params.scheduleId },
      include: {
        programSongs: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!row) return res.status(404).json({ success: false, error: 'Schedule not found' });
    res.json({ success: true, data: shapeSchedule(row) });
  } catch (err) {
    console.error('[schedule:get:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load schedule' });
  }
});

router.post('/', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const id = req.body.id || `schedule_${Date.now()}`;
    const name = (req.body.name || req.body.title || 'Rehearsal Schedule').trim();
    const date = req.body.date || now.toISOString().split('T')[0];
    const orgId = req.body.zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    const inserted = await prisma.program.create({
      data: {
        id,
        name,
        date,
        category: 'schedule',
        organizationId: orgId,
      },
    });

    res.status(201).json({ success: true, message: 'Program created', data: shapeSchedule(inserted) });
  } catch (err: any) {
    console.error('[schedule:create]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to create schedule' });
  }
});

router.patch('/:scheduleId', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { scheduleId } = req.params;
    const existing = await prisma.program.findUnique({ where: { id: scheduleId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    const updateData: any = {};
    if (req.body.name !== undefined) updateData.name = req.body.name;
    if (req.body.date !== undefined) updateData.date = req.body.date;
    if (req.body.status !== undefined) updateData.status = req.body.status;

    const updated = await prisma.program.update({
      where: { id: scheduleId },
      data: updateData,
    });

    res.json({ success: true, message: 'Schedule updated', data: shapeSchedule(updated) });
  } catch (err: any) {
    console.error('[schedule:patch]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update schedule' });
  }
});

router.delete('/:scheduleId', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.program.delete({ where: { id: req.params.scheduleId } });
    res.json({ success: true, message: 'Schedule program deleted' });
  } catch (err) {
    console.error('[schedule:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete schedule' });
  }
});

export default router;
