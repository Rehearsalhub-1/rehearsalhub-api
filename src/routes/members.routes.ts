import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { fetchAllUserMemberships } from '../auth/auth.service';

const router = Router();

function shapeMember(m: any) {
  const user = m.user || m.profile || {};
  const firstName = user.firstName || user.first_name || '';
  const lastName = user.lastName || user.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || user.name || user.email || 'Singer';
  const email = user.email || user.userEmail || '';
  const avatar = user.avatarUrl || user.avatar || user.profile_image_url || null;
  const churchName = m.group?.name || m.churchName || m.church || null;
  const churchId = m.groupId || m.churchId || null;
  const voicePart = m.voicePart || user.voicePart || user.designation || null;

  return {
    id: m.id,
    membershipId: m.id,
    userId: m.userId || user.id || m.id,
    name: fullName,
    userName: fullName,
    displayName: fullName,
    firstName: firstName || fullName.split(' ')[0] || 'Singer',
    lastName: lastName || fullName.split(' ').slice(1).join(' ') || '',
    first_name: firstName || fullName.split(' ')[0] || 'Singer',
    last_name: lastName || fullName.split(' ').slice(1).join(' ') || '',
    email,
    userEmail: email,
    phone: user.phone || null,
    avatarUrl: avatar,
    userAvatar: avatar,
    profile_image_url: avatar,
    kingschatId: user.kingschatId || null,
    organizationId: m.organizationId,
    zoneId: m.organizationId,
    zoneName: m.organization?.name || m.organizationId,
    hqGroupId: m.organizationId,
    hqGroupName: m.organization?.name || m.organizationId,
    groupId: churchId,
    churchId,
    church: churchName,
    churchName,
    role: m.role || 'MEMBER',
    status: m.status || 'ACTIVE',
    voicePart,
    designation: voicePart,
    joinedAt: m.joinedAt || m.createdAt || new Date(),
    profile: {
      ...user,
      firstName: firstName || fullName.split(' ')[0] || 'Singer',
      lastName: lastName || fullName.split(' ').slice(1).join(' ') || '',
      first_name: firstName || fullName.split(' ')[0] || 'Singer',
      last_name: lastName || fullName.split(' ').slice(1).join(' ') || '',
      email,
      avatarUrl: avatar,
    },
    user,
    organization: m.organization,
    group: m.group,
  };
}

// GET /members - query members with optional scope=global and search=...
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'admin' || auth.role === 'hq_admin' || auth.role === 'super_admin';
    const { scope, search, zoneId } = req.query as { scope?: string; search?: string; zoneId?: string };

    let whereClause: any = {};

    if (scope === 'global') {
      if (!isHqAdmin) {
        return res.status(403).json({ success: false, error: 'Global member scope is reserved for HQ administrators' });
      }
      // no organizationId constraint
    } else {
      const targetOrg = zoneId || req.tenant?.effectiveZoneId || auth.zoneId || 'zone-001';
      whereClause.organizationId = targetOrg;
    }

    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim();
      whereClause.OR = [
        { user: { firstName: { contains: q, mode: 'insensitive' } } },
        { user: { lastName: { contains: q, mode: 'insensitive' } } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const memberships = await prisma.membership.findMany({
      where: whereClause,
      include: {
        user: true,
        organization: true,
        group: true,
      },
      take: 100,
      orderBy: { joinedAt: 'desc' },
    });

    const data = memberships.map((m) => {
      const shaped = shapeMember(m);
      return {
        ...shaped,
        churchId: m.groupId || null,
        churchName: m.group?.name || null,
      };
    });

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[members GET /]', err);
    res.status(500).json({ success: false, error: 'Failed to load members' });
  }
});

// GET /members/mine
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const memberships = await fetchAllUserMemberships(userId);

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

    const memberships = await fetchAllUserMemberships(userId);

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
      include: { user: true, organization: true, group: true },
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
      include: { user: true, organization: true, group: true },
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

/** DELETE /members/zone/:membershipId */
router.delete('/zone/:membershipId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { membershipId } = req.params;
    const userId = res.locals.auth.userId as string;

    await prisma.membership.deleteMany({
      where: {
        id: membershipId,
        userId,
      },
    });

    res.json({ success: true, message: 'Membership removed' });
  } catch (err) {
    console.error('[members/zone/:id:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete membership' });
  }
});

/** DELETE /members/:id */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = res.locals.auth;
    const isAdmin =
      auth.role === 'hq_admin' ||
      auth.role === 'admin' ||
      auth.role === 'super_admin' ||
      auth.role === 'zone_admin' ||
      auth.role === 'zone_coordinator';

    // Admins can remove any membership; regular users can only remove their own
    await prisma.membership.deleteMany({
      where: isAdmin ? { id } : { id, userId: auth.userId },
    });

    res.json({ success: true, message: 'Membership deleted' });
  } catch (err) {
    console.error('[members/:id DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete membership' });
  }
});

export default router;

