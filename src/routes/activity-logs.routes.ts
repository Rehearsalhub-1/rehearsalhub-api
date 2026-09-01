import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

/** GET /activity-logs */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'admin' && auth.role !== 'hq_admin' && auth.role !== 'zone_admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    res.json({ success: true, count: 0, data: [] });
  } catch (err) {
    console.error('[activity-logs:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load activity logs' });
  }
});

/** POST /activity-logs */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const logData = {
      id,
      action: req.body.action || 'System Action',
      category: req.body.category || 'general',
      userId: auth.userId,
      userName: req.body.userName || auth.email,
      details: req.body.details || req.body.description || '',
      createdAt: now,
    };

    res.status(201).json({ success: true, message: 'Activity logged', data: logData });
  } catch (err) {
    console.error('[activity-logs:post]', err);
    res.status(500).json({ success: false, error: 'Failed to record activity log' });
  }
});

export default router;
