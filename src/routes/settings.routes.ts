import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { canManageAllTenants, canManageTenant } from '../auth/permissions';

const router = Router();
const idSchema = z.string().min(1).max(200);

function canUpdateSettingKey(key: string, role: unknown): boolean {
  if (canManageAllTenants(role)) return true;
  if (key.startsWith('geofence_') || key.startsWith('clockin_session_')) {
    return canManageTenant(role);
  }
  return false;
}

/** GET /settings/:id */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid id' });
    const row = await prisma.setting.findUnique({ where: { key: parsed.data } });
    if (!row) return res.json({ success: true, data: null });
    const val = typeof row.value === 'object' ? (row.value as any) : {};
    res.json({
      success: true,
      data: {
        id: row.key,
        ...val,
      },
    });
  } catch (err) {
    console.error('[settings/:id:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
});

/** PUT /settings/:id */
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid id' });

    const key = parsed.data;
    if (!canUpdateSettingKey(key, res.locals.auth?.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions to update settings' });
    }

    const bodyData = req.body || {};

    const updated = await prisma.setting.upsert({
      where: { key },
      update: { value: bodyData },
      create: { key, value: bodyData },
    });

    res.json({ success: true, data: updated.value });
  } catch (err) {
    console.error('[settings/:id:put]', err);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

/** PATCH /settings/:id */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid id' });

    const key = parsed.data;
    if (!canUpdateSettingKey(key, res.locals.auth?.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions to update settings' });
    }

    const bodyData = req.body || {};

    const existing = await prisma.setting.findUnique({ where: { key } });
    const prevVal = existing && typeof existing.value === 'object' ? (existing.value as any) : {};
    const nextVal = { ...prevVal, ...bodyData };

    const updated = await prisma.setting.upsert({
      where: { key },
      update: { value: nextVal },
      create: { key, value: nextVal },
    });

    res.json({ success: true, data: updated.value });
  } catch (err) {
    console.error('[settings/:id:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

export default router;
