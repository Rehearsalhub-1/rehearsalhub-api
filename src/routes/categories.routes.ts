import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

function shapeCategory(c: any) {
  return {
    id: c.id,
    name: c.name,
    type: c.type || 'general',
    color: c.color || '#9333ea',
    order: c.order || 0,
    organizationId: c.organizationId || null,
    zoneId: c.organizationId || 'global',
  };
}

// GET /categories
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId, type } = req.query as Record<string, string>;
    const effectiveZoneId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    const rows = await prisma.category.findMany({
      where: {
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
          { organizationId: null },
        ],
        ...(type && type !== 'all' ? { type } : {}),
      },
      orderBy: { order: 'asc' },
    });

    res.json({ success: true, count: rows.length, data: rows.map(shapeCategory) });
  } catch (err) {
    console.error('[categories:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load categories' });
  }
});

// GET /categories/page
router.get('/page', requireAuth, async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.category.findMany({ where: { type: 'PAGE' }, orderBy: { order: 'asc' } });
    res.json({ success: true, data: rows.map(shapeCategory) });
  } catch (err) {
    console.error('[categories/page]', err);
    res.status(500).json({ success: false, error: 'Failed to load page categories' });
  }
});

// POST /categories
router.post('/', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { name, color, type = 'general', zoneId, order } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Category name is required' });
    }

    const id = `cat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const orgId = zoneId || req.tenant?.effectiveZoneId || null;

    const row = await prisma.category.create({
      data: {
        id,
        name: name.trim(),
        color: color || '#9333ea',
        type,
        order: Number(order) || 0,
        organizationId: orgId,
      },
    });

    res.status(201).json({ success: true, data: shapeCategory(row) });
  } catch (err) {
    console.error('[categories POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create category' });
  }
});

// PATCH /categories/:id
router.patch('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, color, type, order } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (color !== undefined) updateData.color = color;
    if (type !== undefined) updateData.type = type;
    if (order !== undefined) updateData.order = Number(order);

    const updated = await prisma.category.update({
      where: { id },
      data: updateData,
    });

    res.json({ success: true, data: shapeCategory(updated) });
  } catch (err) {
    console.error('[categories PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update category' });
  }
});

// DELETE /categories/:id
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.category.delete({ where: { id } });
    res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    console.error('[categories DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete category' });
  }
});

export default router;
