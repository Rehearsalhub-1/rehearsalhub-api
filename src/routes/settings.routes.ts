import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';
import { canManageAllTenants } from '../auth/permissions';

const router = Router();
const idSchema = z.string().min(1).max(200);

/** GET /settings/:id */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid id' });
    const row = await prisma.setting.findUnique({ where: { id: parsed.data } });
    if (!row) return res.json({ success: true, data: null });
    const merged = mergeRawRow(row);
    res.json({
      success: true,
      data: {
        id: row.id,
        latitude: typeof merged.latitude === 'number' ? merged.latitude : Number(merged.latitude) || undefined,
        longitude: typeof merged.longitude === 'number' ? merged.longitude : Number(merged.longitude) || undefined,
        radius: typeof merged.radius === 'number' ? merged.radius : Number(merged.radius) || undefined,
        activeEventName: (merged.activeEventName as string | undefined) || (merged.active_event_name as string | undefined),
        ...merged,
      },
    });
  } catch (err) {
    console.error('[settings/:id:get]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** PUT /settings/:id */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    if (!canManageAllTenants(res.locals.auth?.role)) return res.status(403).json({ success: false, error: 'Forbidden' });
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid id' });

    const id = parsed.data;
    const bodyData = req.body || {};
    const now = new Date().toISOString();
    const existing = await prisma.setting.findUnique({ where: { id } });
    const mergedData = { ...(existing ? mergeRawRow(existing) : {}), ...bodyData, id, updatedAt: now };

    if (existing) {
      await prisma.setting.update({ where: { id }, data: { key: id, value: mergedData } });
    } else {
      await prisma.setting.create({ data: { id, key: id, value: mergedData } });
    }
    res.json({ success: true, data: mergedData });
  } catch (err) {
    console.error('[settings/:id:put]', err);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

/** PATCH /settings/:id */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const role = String(res.locals.auth?.role || '').toLowerCase();
    if (role !== 'admin' && role !== 'hq_admin' && role !== 'super_admin') return res.status(403).json({ success: false, error: 'Forbidden' });
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid id' });

    const id = parsed.data;
    const bodyData = req.body || {};
    const now = new Date().toISOString();
    const existing = await prisma.setting.findUnique({ where: { id } });
    const mergedData = { ...(existing ? mergeRawRow(existing) : {}), ...bodyData, id, updatedAt: now };

    if (existing) {
      await prisma.setting.update({ where: { id }, data: { key: id, value: mergedData } });
    } else {
      await prisma.setting.create({ data: { id, key: id, value: mergedData } });
    }
    res.json({ success: true, data: mergedData });
  } catch (err) {
    console.error('[settings/:id:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

export default router;
