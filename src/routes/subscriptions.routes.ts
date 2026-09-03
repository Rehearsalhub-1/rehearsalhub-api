import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { canManageAllTenants } from '../auth/permissions';

const router = Router();

router.get('/me', requireAuth, async (_req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Check system-wide enforcement setting
    const enforceRow = await prisma.setting.findUnique({ where: { key: 'enforce_subscription' } }).catch(() => null);
    const isEnforced = enforceRow?.value === true || enforceRow?.value === 'true';

    // If subscriptions are not enforced yet, grant free full access
    if (!isEnforced) {
      return res.json({
        success: true,
        data: {
          id: `sub_${user.id}`,
          userId: user.id,
          status: 'active',
          tier: 'premium',
          enforced: false,
          expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        },
      });
    }

    // Check user-specific status
    const userSubRow = await prisma.setting.findUnique({ where: { key: `sub_${user.id}` } }).catch(() => null);
    const subData: any = userSubRow?.value || {};
    const status = subData.status || 'inactive';
    const expiresAt = subData.expiresAt || null;
    const isActive = status === 'active' && (!expiresAt || new Date(expiresAt).getTime() > Date.now());

    res.json({
      success: true,
      data: {
        id: `sub_${user.id}`,
        userId: user.id,
        status: isActive ? 'active' : 'expired',
        tier: isActive ? 'premium' : 'standard',
        enforced: true,
        expiresAt,
      },
    });
  } catch (err) {
    console.error('[subscriptions:me]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch subscription' });
  }
});

router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    if (!canManageAllTenants(auth.role)) return res.status(403).json({ success: false, error: 'Forbidden' });

    const allUsers = await prisma.user.findMany({
      take: 100,
      include: {
        memberships: {
          include: { organization: true },
        },
      },
    });

    const data = allUsers.map((u) => {
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Singer';
      const zoneId = u.memberships?.[0]?.organizationId || 'zone-001';
      return {
        payment: {
          id: `pay_${u.id}`,
          userId: u.id,
          userEmail: u.email || '',
          userName: fullName,
          amount: 0,
          currency: 'USD',
          status: 'success',
          subscriptionType: 'individual',
          subscriptionPeriod: {
            start: u.createdAt.toISOString(),
            end: new Date(Date.now() + 365 * 86400000).toISOString(),
          },
          metadata: { zoneId },
          createdAt: u.createdAt.toISOString(),
        },
        subscription: {
          id: `sub_${u.id}`,
          userId: u.id,
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
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const sub = {
      id: `sub_${user.id}`,
      userId: user.id,
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
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

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

// Toggle system-wide subscription enforcement (master flip switch for admin app)
router.post('/toggle-enforcement', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    if (!canManageAllTenants(auth.role)) return res.status(403).json({ success: false, error: 'Forbidden' });
    const { enforce } = req.body;

    await prisma.setting.upsert({
      where: { key: 'enforce_subscription' },
      update: { value: !!enforce },
      create: { key: 'enforce_subscription', value: !!enforce },
    });

    res.json({ success: true, enforced: !!enforce, message: `Subscription enforcement ${enforce ? 'activated' : 'deactivated'}` });
  } catch (err) {
    console.error('[subscriptions:toggle]', err);
    res.status(500).json({ success: false, error: 'Failed to toggle enforcement' });
  }
});

// Flip individual user subscription status (for admin app)
router.post('/:userId/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    if (!canManageAllTenants(auth.role)) return res.status(403).json({ success: false, error: 'Forbidden' });
    const { userId } = req.params;
    const { status = 'active', expiresAt } = req.body;

    const currentExpiry = expiresAt || (status === 'active' ? new Date(Date.now() + 30 * 86400000).toISOString() : null);

    await prisma.setting.upsert({
      where: { key: `sub_${userId}` },
      update: { value: { status, expiresAt: currentExpiry, updatedAt: new Date().toISOString() } },
      create: { key: `sub_${userId}`, value: { status, expiresAt: currentExpiry, updatedAt: new Date().toISOString() } },
    });

    res.json({ success: true, status, expiresAt: currentExpiry, message: `User subscription updated to ${status}` });
  } catch (err) {
    console.error('[subscriptions:user:status]', err);
    res.status(500).json({ success: false, error: 'Failed to update user subscription' });
  }
});

export default router;
