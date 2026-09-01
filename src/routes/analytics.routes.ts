import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

// GET /analytics/events
router.get('/events', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'super_admin' && auth.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    res.json({ success: true, data: [], count: 0 });
  } catch (err) {
    console.error('[Analytics] GET /events error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

export default router;
