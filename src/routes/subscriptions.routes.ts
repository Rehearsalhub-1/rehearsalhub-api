import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { canManageAllTenants } from '../auth/permissions';

const router = Router();

router.get('/me', requireAuth, async (_req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const profile = await prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

    const sub = {
      id: `sub_${profile.id}`,
      userId: profile.id,
      status: 'active',
      tier: 'premium',
      plan: 'monthly',
      expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
    };
    res.json({ success: true, data: sub });
  } catch (err) {
    console.error('[subscriptions:me]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch subscription' });
  }
});

router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    if (!canManageAllTenants(auth.role)) return res.status(403).json({ success: false, error: 'Forbidden' });

    const allProfiles = await prisma.profile.findMany({
      take: 100,
    });

    const data = allProfiles.map((p) => {
      const fullName = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Singer';
      return {
        payment: {
          id: `pay_${p.id}`,
          userId: p.id,
          userEmail: p.email || '',
          userName: fullName,
          amount: 0,
          currency: 'USD',
          status: 'success',
          subscriptionType: 'individual',
          subscriptionPeriod: {
            start: p.createdAt.toISOString(),
            end: new Date(Date.now() + 365 * 86400000).toISOString(),
          },
          metadata: { zoneId: 'zone-001' },
          createdAt: p.createdAt.toISOString(),
        },
        subscription: {
          id: `sub_${p.id}`,
          userId: p.id,
          status: 'active',
          plan: 'premium',
        },
      };
    });

    res.json({ success: true, count: data.length, data, subscriptions: data });
  } catch (err) {
    console.error('[subscriptions:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load subscriptions' });
  }
});

router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.userId !== userId && auth.role !== 'hq_admin' && auth.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const profile = await prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

    const sub = {
      id: `sub_${profile.id}`,
      userId: profile.id,
      status: 'active',
      tier: 'premium',
      plan: 'monthly',
      expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
    };
    res.json({ success: true, data: sub });
  } catch (err) {
    console.error('[subscriptions:userId]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch subscription' });
  }
});

router.post('/:userId/extend', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { months = 1 } = req.body;
    const auth = res.locals.auth;
    if (!canManageAllTenants(auth.role)) return res.status(403).json({ success: false, error: 'Forbidden' });
    const profile = await prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

    const newExpiry = new Date(Date.now() + Number(months) * 30 * 86400000).toISOString();
    res.json({ success: true, message: `Subscription extended by ${months} month(s)`, expiresAt: newExpiry });
  } catch (err) {
    console.error('[subscriptions:extend]', err);
    res.status(500).json({ success: false, error: 'Failed to extend subscription' });
  }
});

router.post('/:userId/revoke', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.userId !== userId && auth.role !== 'hq_admin' && auth.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    res.json({ success: true, message: 'Subscription revoked' });
  } catch (err) {
    console.error('[subscriptions:revoke]', err);
    res.status(500).json({ success: false, error: 'Failed to revoke subscription' });
  }
});

export default router;
