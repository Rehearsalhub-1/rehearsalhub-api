import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';

const router = Router();

// GET /categories
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    const zoneId = (req.query.zoneId && req.query.zoneId !== 'all')
      ? String(req.query.zoneId)
      : (!isHqAdmin ? (auth.zoneId as string | null) : null);

    const rows = await prisma.category.findMany();
    const data = rows.map(mergeRawRow);
    const filtered = zoneId
      ? data.filter((c: any) => !c.zoneId || c.zoneId === 'global' || c.zoneId === zoneId || c.zone_id === zoneId)
      : data;

    filtered.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
    res.json({ success: true, data: filtered });
  } catch (err) {
    console.error('[categories]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// GET /categories/page
router.get('/page', requireAuth, async (_req, res) => {
  try {
    const rows = await prisma.category.findMany({ where: { type: 'page' } });
    res.json({ success: true, data: rows.map(mergeRawRow) });
  } catch (err) {
    console.error('[categories/page]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// GET /categories/zone-page
router.get('/zone-page', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    const effectiveZoneId = (req.query.zoneId && req.query.zoneId !== 'all')
      ? String(req.query.zoneId)
      : (!isHqAdmin ? (auth.zoneId as string | null) : null);

    const rows = await prisma.category.findMany({
      where: {
        type: 'page',
        ...(effectiveZoneId ? { zoneId: effectiveZoneId } : {}),
      },
    });

    res.json({ success: true, data: rows.map(mergeRawRow) });
  } catch (err) {
    console.error('[categories/zone-page]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /categories
router.post('/', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { name, color, description, zoneId } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, error: 'Name is required' });
      return;
    }
    const id = `cat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const rawData = {
      id, name: name.trim(), color: color || '#9333ea',
      description: description?.trim() || null, isActive: true,
      zoneId: zoneId || 'global', createdAt: new Date().toISOString(),
    };

    const row = await prisma.category.create({
      data: {
        id,
        name: name.trim(),
        color: color || '#9333ea',
        scope: zoneId && zoneId !== 'global' ? 'zone' : 'hq',
        zoneId: zoneId || null,
        type: 'program',
        rawData,
      },
    });

    res.status(201).json({ success: true, message: 'Category created', data: mergeRawRow(row) });
  } catch (err) {
    console.error('[categories POST]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// PATCH /categories/:id
router.patch('/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const categoryId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Category not found' });
      return;
    }

    const updatedRaw = { ...(existing.rawData as Record<string, unknown> || {}), ...body, updatedAt: new Date().toISOString() };
    const row = await prisma.category.update({
      where: { id: categoryId },
      data: {
        name: body.name !== undefined ? body.name : existing.name,
        color: body.color !== undefined ? body.color : existing.color,
        rawData: updatedRaw,
      },
    });

    res.json({ success: true, message: 'Category updated', data: mergeRawRow(row) });
  } catch (err) {
    console.error('[categories PATCH]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// DELETE /categories/:id
router.delete('/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const categoryId = req.params.id;
    await prisma.category.deleteMany({ where: { id: categoryId } });
    res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    console.error('[categories DELETE]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /categories/page
router.post('/page', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const pageCatId = body.id || `pc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const zoneId = body.zoneId || body.zone_id;
    const rawData = { id: pageCatId, name: body.name || '', description: body.description || '', image: body.image || '', zoneId: zoneId || null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...body };

    const row = await prisma.category.create({
      data: {
        id: pageCatId,
        name: body.name || 'Page Category',
        scope: zoneId ? 'zone' : 'hq',
        zoneId: zoneId || null,
        type: 'page',
        rawData,
      },
    });
    res.status(201).json({ success: true, message: 'Page category created', data: mergeRawRow(row) });
  } catch (err) {
    console.error('[categories/page POST]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// PATCH /categories/page/:id
router.patch('/page/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const pageCatId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.category.findUnique({ where: { id: pageCatId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Page category not found' });

    const updatedRaw = { ...(existing.rawData as Record<string, unknown> || {}), ...body, updatedAt: new Date().toISOString() };
    const row = await prisma.category.update({
      where: { id: pageCatId },
      data: {
        name: body.name !== undefined ? body.name : existing.name,
        rawData: updatedRaw,
      },
    });
    res.json({ success: true, message: 'Page category updated', data: mergeRawRow(row) });
  } catch (err) {
    console.error('[categories/page PATCH]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// DELETE /categories/page/:id
router.delete('/page/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const pageCatId = req.params.id;
    await prisma.category.deleteMany({ where: { id: pageCatId } });
    res.json({ success: true, message: 'Page category deleted' });
  } catch (err) {
    console.error('[categories/page DELETE]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /categories/page/order
router.post('/page/order', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const rawOrder = Array.isArray(req.body) ? req.body : req.body?.order;
    if (!Array.isArray(rawOrder)) return res.status(400).json({ success: false, error: 'Order array required' });
    const zoneId = req.body?.zoneId;

    for (let i = 0; i < rawOrder.length; i++) {
      const item = rawOrder[i];
      const itemId = typeof item === 'string' ? item : (item.id || item.firebaseId || item._id);
      if (!itemId) continue;

      const existing = await prisma.category.findUnique({ where: { id: String(itemId) } });

      if (existing) {
        const updatedRaw = { ...(existing.rawData as Record<string, unknown> || {}), ...(typeof item === 'object' ? item : {}), orderIndex: i, order: i };
        await prisma.category.update({ where: { id: String(itemId) }, data: { order: i, rawData: updatedRaw } });
      } else if (typeof item === 'object') {
        const rawData = { ...item, orderIndex: i, order: i, ...(zoneId ? { zoneId } : {}) };
        try {
          await prisma.category.create({
            data: {
              id: String(itemId),
              name: item.name || 'Category',
              type: 'page',
              order: i,
              scope: zoneId ? 'zone' : 'hq',
              zoneId: zoneId || null,
              rawData,
            },
          });
        } catch { /* already exists, skip */ }
      }
    }

    res.json({ success: true, message: 'Page categories reordered successfully' });
  } catch (err) {
    console.error('[categories/page/order]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

export default router;
