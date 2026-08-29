import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

// GET /analytics/events — list analytics events (hq_admin and super_admin only)
router.get('/events', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;

    if (auth.role !== 'hq_admin' && auth.role !== 'super_admin') {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const limitParam = parseInt(String(req.query.limit || '100'), 10);
    const limit = Math.min(isNaN(limitParam) ? 100 : limitParam, 500);
    const since = req.query.since ? new Date(String(req.query.since)) : null;

    const rows = await prisma.analyticsEvent.findMany({
      take: limit,
      orderBy: { id: 'desc' },
    });

    const filtered = since
      ? rows.filter((r: any) => {
          const raw = r.rawData as Record<string, any> | null;
          if (!raw?.createdAt) return false;
          return new Date(raw.createdAt) >= (since as Date);
        })
      : rows;

    res.json({ success: true, data: filtered, count: filtered.length });
  } catch (err) {
    console.error('[Analytics] GET /events error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

export default router;
