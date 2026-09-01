import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

function shapeGroup(g: any) {
  return {
    id: g.id,
    name: g.name,
    code: g.name.slice(0, 4).toUpperCase(),
    organizationId: g.organizationId,
    zoneId: g.organizationId,
    type: g.type || 'church',
    status: g.status || 'active',
    description: g.description || '',
    estimatedMembers: g.estimatedMembers || 0,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/** GET /subgroups/mine */
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const memberships = await prisma.membership.findMany({
      where: { userId, groupId: { not: null } },
      include: { group: true },
    });

    const groups = memberships.map((m) => m.group).filter(Boolean);
    res.json({ success: true, data: groups.map(shapeGroup) });
  } catch (err) {
    console.error('[subgroups/mine]', err);
    res.status(500).json({ success: false, error: 'Failed to load your groups' });
  }
});

/** GET /subgroups/coordinated */
router.get('/coordinated', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const memberships = await prisma.membership.findMany({
      where: { userId, role: 'GROUP_ADMIN', groupId: { not: null } },
      include: { group: true },
    });

    const groups = memberships.map((m) => m.group).filter(Boolean);
    res.json({ success: true, data: groups.map(shapeGroup) });
  } catch (err) {
    console.error('[subgroups/coordinated]', err);
    res.status(500).json({ success: false, error: 'Failed to load coordinated groups' });
  }
});

/** GET /subgroups/requests — List pending group approval requests */
router.get('/requests', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const effectiveZoneId = req.tenant?.effectiveZoneId || 'zone-001';

    const groups = await prisma.group.findMany({
      where: {
        status: 'pending',
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, count: groups.length, data: groups.map(shapeGroup) });
  } catch (err) {
    console.error('[subgroups/requests]', err);
    res.status(500).json({ success: false, error: 'Failed to load group requests' });
  }
});

/** GET /subgroups - List groups */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const effectiveZoneId = req.tenant?.effectiveZoneId || 'zone-001';

    const groups = await prisma.group.findMany({
      where: {
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
        ],
      },
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, count: groups.length, data: groups.map(shapeGroup) });
  } catch (err) {
    console.error('[subgroups/ GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load groups' });
  }
});

/** GET /subgroups/:id */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const group = await prisma.group.findUnique({ where: { id: req.params.id } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
    res.json({ success: true, data: shapeGroup(group) });
  } catch (err) {
    console.error('[subgroups/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load group' });
  }
});

/** GET /subgroups/:id/members — List members in this group */
router.get('/:id/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const memberships = await prisma.membership.findMany({
      where: { groupId: id },
      include: { user: true },
    });

    const members = memberships.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      name: [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') || m.user.email || 'Member',
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      status: m.status,
      voicePart: m.voicePart,
      joinedAt: m.joinedAt,
    }));

    res.json({ success: true, count: members.length, data: members });
  } catch (err) {
    console.error('[subgroups/:id/members:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load members' });
  }
});

/** POST /subgroups/:id/members — Add user to church/group */
router.post('/:id/members', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: group.organizationId },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: id },
      });
    } else {
      await prisma.membership.create({
        data: {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId,
          organizationId: group.organizationId,
          groupId: id,
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });
    }

    res.json({ success: true, message: 'Member added to group' });
  } catch (err) {
    console.error('[subgroups/:id/members:post]', err);
    res.status(500).json({ success: false, error: 'Failed to add member' });
  }
});

/** DELETE /subgroups/:id/members/:userId — Remove user from group */
router.delete('/:id/members/:userId', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id, userId } = req.params;
    const membership = await prisma.membership.findFirst({
      where: { userId, groupId: id },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: null },
      });
    }

    res.json({ success: true, message: 'Member removed from group' });
  } catch (err) {
    console.error('[subgroups/:id/members:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

/** POST /subgroups/:id/assign-coordinator */
router.post('/:id/assign-coordinator', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { email, userId } = req.body;

    let targetUser: any = null;
    if (userId) {
      targetUser = await prisma.user.findUnique({ where: { id: userId } });
    } else if (email) {
      targetUser = await prisma.user.findFirst({ where: { email: email.toLowerCase().trim() } });
    }

    if (!targetUser) return res.status(404).json({ success: false, error: 'User not found' });

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const membership = await prisma.membership.findFirst({
      where: { userId: targetUser.id, organizationId: group.organizationId },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: id, role: 'GROUP_ADMIN' },
      });
    } else {
      await prisma.membership.create({
        data: {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: targetUser.id,
          organizationId: group.organizationId,
          groupId: id,
          role: 'GROUP_ADMIN',
          status: 'ACTIVE',
        },
      });
    }

    res.json({ success: true, message: 'Coordinator assigned successfully' });
  } catch (err) {
    console.error('[subgroups/:id/assign-coordinator]', err);
    res.status(500).json({ success: false, error: 'Failed to assign coordinator' });
  }
});

/** POST /subgroups - Create group */
router.post('/', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { name, description, type = 'church', zoneId, estimatedMembers } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Group name is required' });
    }

    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const group = await prisma.group.create({
      data: {
        id,
        organizationId: orgId,
        name: name.trim(),
        description: description?.trim() || null,
        type,
        status: 'active',
        estimatedMembers: Number(estimatedMembers) || 0,
      },
    });

    res.status(201).json({ success: true, data: shapeGroup(group) });
  } catch (err: any) {
    console.error('[subgroups POST]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to create group' });
  }
});

/** PATCH /subgroups/:id - Update group */
router.patch('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, type, status, estimatedMembers } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (type !== undefined) updateData.type = type;
    if (status !== undefined) updateData.status = status;
    if (estimatedMembers !== undefined) updateData.estimatedMembers = Number(estimatedMembers);

    const updated = await prisma.group.update({
      where: { id },
      data: updateData,
    });

    res.json({ success: true, data: shapeGroup(updated) });
  } catch (err: any) {
    console.error('[subgroups PATCH]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update group' });
  }
});

/** DELETE /subgroups/:id */
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.group.delete({ where: { id } });
    res.json({ success: true, message: 'Group deleted successfully' });
  } catch (err: any) {
    console.error('[subgroups DELETE]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete group' });
  }
});

export default router;
