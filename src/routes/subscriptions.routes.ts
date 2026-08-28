import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { canManageAllTenants } from '../auth/permissions';
import { mergeRawRow } from '../lib/rawRow';

const router = Router();

router.get('/me', requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const profile = await prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });
    const raw = (profile.rawData && typeof profile.rawData === 'object') ? (profile.rawData as Record<string, any>) : {};
    const sub = raw.subscription || {
      id: `sub_${profile.id}`,
      userId: profile.id,
      status: raw.status === 'active' ? 'active' : 'inactive',
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

router.get('/', requireAuth, async (_req, res) => {
  try {
    const auth = res.locals.auth;
    if (!canManageAllTenants(auth.role)) return res.status(403).json({ success: false, error: 'Forbidden' });

    const allProfiles = await prisma.profile.findMany();
    const data = allProfiles.map((p) => {
      const rawP = (p?.rawData && typeof p.rawData === 'object') ? (p.rawData as Record<string, any>) : {};
      const fullName = [p?.firstName, p?.lastName].filter(Boolean).join(' ') || (rawP.first_name ? `${rawP.first_name} ${rawP.last_name || ''}` : '') || 'Singer';
      const email = p?.email || rawP.email || '';
      const zoneName = rawP.zoneName || rawP.zone_name || rawP.zone_code || 'Assigned Zone';
      const sub = rawP.subscription || {
        id: `sub_${p.id}`,
        userId: p.id,
        status: rawP.status === 'active' ? 'active' : 'inactive',
        tier: 'premium',
        plan: 'monthly',
        expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
      };
      return {
        payment: {
          id: `pay_${p.id}`,
          userId: p.id,
          userEmail: email,
          userName: fullName,
          amount: 1500,
          currency: 'USD',
          status: 'success',
          subscriptionType: 'individual',
          subscriptionPeriod: { start: new Date().toISOString(), end: sub.expiresAt },
          metadata: { zoneId: rawP.zone_code || rawP.zoneId, zoneName },
          createdAt: new Date().toISOString(),
        },
        subscription: sub,
      };
    });

    res.json({ success: true, count: data.length, data, subscriptions: data });
  } catch (err) {
    console.error('[subscriptions:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load subscriptions' });
  }
});

router.get('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.userId !== userId && auth.role !== 'hq_admin' && auth.role !== 'admin') return res.status(403).json({ success: false, error: 'Forbidden' });
    const profile = await prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });
    const raw = (profile.rawData && typeof profile.rawData === 'object') ? (profile.rawData as Record<string, any>) : {};
    const sub = raw.subscription || {
      id: `sub_${profile.id}`,
      userId: profile.id,
      status: raw.status === 'active' ? 'active' : 'inactive',
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

router.post('/:userId/extend', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { months = 1 } = req.body;
    const auth = res.locals.auth;
    if (!canManageAllTenants(auth.role)) return res.status(403).json({ success: false, error: 'Forbidden' });
    const profile = await prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });
    const prevRaw = (profile.rawData && typeof profile.rawData === 'object') ? (profile.rawData as Record<string, any>) : {};
    const currentExpiry = prevRaw.subscription?.expiresAt ? new Date(prevRaw.subscription.expiresAt) : new Date();
    const newExpiry = new Date(currentExpiry.setMonth(currentExpiry.getMonth() + Number(months))).toISOString();
    const updatedSub = {
      ...(prevRaw.subscription || {}),
      id: prevRaw.subscription?.id || `sub_${profile.id}`,
      userId: profile.id,
      status: 'active',
      expiresAt: newExpiry,
    };
    await prisma.profile.update({
      where: { id: userId },
      data: { rawData: { ...prevRaw, subscription: updatedSub } },
    });
    res.json({ success: true, message: `Subscription extended by ${months} month(s)`, expiresAt: newExpiry });
  } catch (err) {
    console.error('[subscriptions:extend]', err);
    res.status(500).json({ success: false, error: 'Failed to extend subscription' });
  }
});

router.post('/:userId/revoke', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.userId !== userId && auth.role !== 'hq_admin' && auth.role !== 'admin') return res.status(403).json({ success: false, error: 'Forbidden' });
    const profile = await prisma.profile.findUnique({ where: { id: userId } });
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });
    const prevRaw = (profile.rawData && typeof profile.rawData === 'object') ? (profile.rawData as Record<string, any>) : {};
    const updatedSub = {
      ...(prevRaw.subscription || {}),
      id: prevRaw.subscription?.id || `sub_${profile.id}`,
      userId: profile.id,
      status: 'cancelled',
    };
    await prisma.profile.update({
      where: { id: userId },
      data: { rawData: { ...prevRaw, subscription: updatedSub } },
    });
    res.json({ success: true, message: 'Subscription revoked' });
  } catch (err) {
    console.error('[subscriptions:revoke]', err);
    res.status(500).json({ success: false, error: 'Failed to revoke subscription' });
  }
});

export default router;
