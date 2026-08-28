import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

// GET /zones
router.get('/', requireAuth, async (_req, res) => {
  const rows = await prisma.zone.findMany();
  res.json({ success: true, data: rows });
});

// GET /zones/:zoneId
router.get('/:zoneId', requireAuth, async (req, res) => {
  const zone = await prisma.zone.findUnique({ where: { id: req.params.zoneId } });
  if (!zone) return res.status(404).json({ success: false, error: 'Zone not found' });
  res.json({ success: true, data: zone });
});

// GET /zones/:zoneId/members
router.get('/:zoneId/members', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const role = String(auth?.role || '').toLowerCase();
  const isHqAdmin = role === 'hq_admin' || role === 'admin' || role === 'super_admin';
  const requestedZoneId = String(req.params.zoneId || '').trim().toLowerCase();
  const authZoneId = String(auth?.zoneId || '').trim().toLowerCase();
  const norm = (s: string) => s.replace(/-/g, '');
  if (!isHqAdmin && (!authZoneId || norm(requestedZoneId) !== norm(authZoneId))) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const members = await prisma.profile.findMany({ where: { zoneId: req.params.zoneId } });
  res.json({ success: true, data: members });
});

export default router;
