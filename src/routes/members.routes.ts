import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { fetchAllUserMemberships } from '../auth/auth.service';

const router = Router();

function shapeMember(m: any) {
  const user = m.user || m.profile || {};
  return {
    id: m.id,
    userId: m.userId,
    userName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Singer',
    userEmail: user.email || '',
    userAvatar: user.avatarUrl || null,
    phone: user.phone || null,
    kingschatId: user.kingschatId || null,
    organizationId: m.organizationId,
    zoneId: m.organizationId,
    zoneName: m.organization?.name || m.organizationId,
    hqGroupId: m.organizationId,
    hqGroupName: m.organization?.name || m.organizationId,
    role: m.role || 'MEMBER',
    status: m.status || 'ACTIVE',
    joinedAt: m.joinedAt || m.createdAt || new Date(),
    profile: user,
    organization: m.organization,
  };
}

// GET /members/mine
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const rawProfileRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT raw_data FROM profiles WHERE id = $1 LIMIT 1`,
      userId
    ).catch(() => []);
    const rawData = rawProfileRows[0]?.raw_data || {};
    const memberships = await fetchAllUserMemberships(userId, rawData);

    const zoneMembers = memberships.filter((m) => !m.hasHqAccess).map(shapeMember);
    const hqMembers = memberships.filter((m) => m.hasHqAccess).map(shapeMember);

    res.json({ success: true, data: { zoneMembers, hqMembers, memberships: memberships.map(shapeMember) } });
  } catch (err) {
    console.error('[members/mine]', err);
    res.status(500).json({ success: false, error: 'Failed to load memberships' });
  }
});

// GET /members/by-user/:userId
router.get('/by-user/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { userId } = req.params;
    const isSelf = auth.userId === userId;
    const isAdmin = auth.role === 'admin' || auth.role === 'hq_admin';
    if (!isSelf && !isAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });

    const rawProfileRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT raw_data FROM profiles WHERE id = $1 LIMIT 1`,
      userId
    ).catch(() => []);
    const rawData = rawProfileRows[0]?.raw_data || {};
    const memberships = await fetchAllUserMemberships(userId, rawData);

    const zoneMembers = memberships.filter((m) => !m.hasHqAccess).map(shapeMember);
    const hqMembers = memberships.filter((m) => m.hasHqAccess).map(shapeMember);

    res.json({ success: true, data: { zoneMembers, hqMembers, memberships: memberships.map(shapeMember) } });
  } catch (err) {
    console.error('[members/by-user]', err);
    res.status(500).json({ success: false, error: 'Failed to load user memberships' });
  }
});

// GET /members/hq
router.get('/hq', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'admin' && auth.role !== 'hq_admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const memberships = await prisma.membership.findMany({
      where: {
        OR: [
          { organizationId: 'zone-001' },
          { organization: { isHq: true } },
        ],
      },
      include: { user: true, organization: true },
      take: 200,
    });

    res.json({ success: true, count: memberships.length, data: memberships.map(shapeMember) });
  } catch (err) {
    console.error('[members/hq]', err);
    res.status(500).json({ success: false, error: 'Failed to load HQ members' });
  }
});

// GET /members/zone/:zoneId
router.get('/zone/:zoneId', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const targetZoneId = req.params.zoneId;
    const isHQAdmin = auth.role === 'admin' || auth.role === 'hq_admin' || auth.role === 'super_admin';
    if (!isHQAdmin && auth.zoneId !== targetZoneId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const memberships = await prisma.membership.findMany({
      where: { organizationId: targetZoneId },
      include: { user: true, organization: true },
      take: 200,
    });

    res.json({ success: true, count: memberships.length, data: memberships.map(shapeMember) });
  } catch (err) {
    console.error('[members/zone]', err);
    res.status(500).json({ success: false, error: 'Failed to load zone members' });
  }
});

// POST /members/zone-join
router.post('/zone-join', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { zone_id, is_hq } = req.body;
    const orgId = is_hq ? 'zone-001' : (zone_id || req.tenant?.effectiveZoneId || 'zone-001');

    await prisma.membership.upsert({
      where: { userId_organizationId: { userId, organizationId: orgId } },
      create: { userId, organizationId: orgId, role: 'MEMBER', status: 'ACTIVE' },
      update: { status: 'ACTIVE' },
    });

    res.json({ success: true, message: 'Successfully joined organization' });
  } catch (err) {
    console.error('[members/zone-join]', err);
    res.status(500).json({ success: false, error: 'Failed to join organization' });
  }
});

// POST /members/zone-leave
router.post('/zone-leave', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { zone_id } = req.body;
    const orgId = zone_id || req.tenant?.effectiveZoneId;

    if (orgId) {
      await prisma.membership.deleteMany({
        where: { userId, organizationId: orgId },
      });
    }

    res.json({ success: true, message: 'Successfully left organization' });
  } catch (err) {
    console.error('[members/zone-leave]', err);
    res.status(500).json({ success: false, error: 'Failed to leave organization' });
  }
});

// PATCH /members/:userId
router.patch('/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isOwner = auth.userId === userId;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    if (!isOwner && !isHqAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });

    const body = req.body || {};
    const firstName = body.first_name || body.firstName;
    const lastName = body.last_name || body.lastName;
    const phone = body.phone_number || body.phoneNumber;
    const kingschatId = body.kingschat_id || body.kingschatId;
    const avatar = body.profile_image_url || body.avatar_url || body.avatar;

    const updateData: Record<string, any> = {
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(kingschatId !== undefined ? { kingschatId } : {}),
      ...(avatar !== undefined ? { avatarUrl: avatar } : {}),
      ...(body.email !== undefined ? { email: body.email.trim().toLowerCase() } : {}),
    };

    const updated = await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    res.json({ success: true, message: 'Member updated successfully', data: updated });
  } catch (err: any) {
    console.error('[members/:userId PATCH]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update member' });
  }
});

export default router;
