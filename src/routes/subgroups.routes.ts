import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin, requireZoneOrHqAdmin } from '../auth/auth.middleware';
import { isZonalOrHQAdminRole } from '../auth/auth.service';
import { isHQRole } from '../auth/permissions';

const router = Router();

function shapeGroup(g: any, groupMeta?: any) {
  const coordMap = new Map<string, { id: string; name: string; email: string }>();

  if (Array.isArray(groupMeta?.coordinators)) {
    for (const c of groupMeta.coordinators) {
      const cid = String(c?.id || c?.userId || '').trim();
      if (cid) {
        coordMap.set(cid, {
          id: cid,
          name: String(c?.name || c?.email || 'Coordinator'),
          email: String(c?.email || ''),
        });
      }
    }
  }

  if (groupMeta?.coordinatorId && !coordMap.has(String(groupMeta.coordinatorId))) {
    coordMap.set(String(groupMeta.coordinatorId), {
      id: String(groupMeta.coordinatorId),
      name: String(groupMeta.coordinatorName || groupMeta.coordinatorEmail || 'Coordinator'),
      email: String(groupMeta.coordinatorEmail || ''),
    });
  }

  if (Array.isArray(g.memberships)) {
    for (const m of g.memberships) {
      const u = m?.user;
      if (u?.id && !coordMap.has(String(u.id))) {
        const uName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Coordinator';
        coordMap.set(String(u.id), {
          id: String(u.id),
          name: uName,
          email: u.email || '',
        });
      }
    }
  }

  const coordinators = Array.from(coordMap.values());
  const primary = coordinators[0];

  const coordinatorName =
    coordinators.length > 2
      ? `${coordinators[0].name}, ${coordinators[1].name} +${coordinators.length - 2}`
      : coordinators.length > 0
        ? coordinators.map((c) => c.name).join(', ')
        : g.coordinatorName || undefined;

  const coordinatorEmail = primary?.email || g.coordinatorEmail || undefined;
  const coordinatorId = primary?.id || g.coordinatorId || undefined;

  return {
    id: g.id,
    name: g.name,
    code: g.code || g.name.slice(0, 4).toUpperCase(),
    organizationId: g.organizationId,
    zoneId: g.organizationId,
    type: g.type || 'church',
    status: g.status || 'active',
    description: g.description || '',
    estimatedMembers: g.estimatedMembers || 0,
    memberCount: g._count?.memberships ?? g.memberCount ?? 0,
    coordinatorId,
    coordinatorName,
    coordinatorEmail,
    coordinators,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

async function getUserCoordinatedGroups(userId: string, includeMemberGroups: boolean = false) {
  const memberships = await prisma.membership.findMany({
    where: includeMemberGroups
      ? { userId, groupId: { not: null } }
      : {
          userId,
          groupId: { not: null },
          role: {
            in: [
              'GROUP_ADMIN', 'group_admin',
              'CHURCH_COORDINATOR', 'church_coordinator',
              'CHURCH_ADMIN', 'church_admin',
              'SUBGROUP_ADMIN', 'subgroup_admin',
              'SUBGROUP_COORDINATOR', 'subgroup_coordinator',
              'ZONE_ADMIN', 'zone_admin',
              'ZONE_COORDINATOR', 'zone_coordinator',
              'HQ_ADMIN', 'hq_admin', 'ADMIN', 'admin', 'SUPER_ADMIN', 'super_admin',
            ],
          },
        },
    include: { group: true },
  });

  const groupMap = new Map<string, any>();
  for (const m of memberships) {
    if (m.group) {
      groupMap.set(m.group.id, m.group);
    }
  }

  try {
    const metaSetting = await prisma.setting.findUnique({ where: { key: `profile_meta_${userId}` } });
    const meta: any = metaSetting?.value || {};
    const extraIds = new Set<string>();
    if (meta.churchId && !groupMap.has(String(meta.churchId))) {
      extraIds.add(String(meta.churchId));
    }
    if (Array.isArray(meta.churches)) {
      for (const c of meta.churches) {
        const cid = c?.id || c?.churchId || c?.groupId;
        if (cid && !groupMap.has(String(cid))) {
          extraIds.add(String(cid));
        }
      }
    }
    if (extraIds.size > 0) {
      const extraGroups = await prisma.group.findMany({
        where: { id: { in: Array.from(extraIds) } },
      });
      for (const g of extraGroups) {
        groupMap.set(g.id, g);
      }
    }
  } catch {}

  return Array.from(groupMap.values());
}

/** GET /subgroups/mine */
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const groups = await getUserCoordinatedGroups(userId, true);
    res.json({ success: true, data: groups.map((g) => shapeGroup(g)) });
  } catch (err) {
    console.error('[subgroups/mine]', err);
    res.status(500).json({ success: false, error: 'Failed to load your groups' });
  }
});

/** GET /subgroups/coordinated */
router.get('/coordinated', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const groups = await getUserCoordinatedGroups(userId, false);
    res.json({ success: true, data: groups.map((g) => shapeGroup(g)) });
  } catch (err) {
    console.error('[subgroups/coordinated]', err);
    res.status(500).json({ success: false, error: 'Failed to load coordinated groups' });
  }
});

/** GET /subgroups/requests — Legacy stub, requests are disabled */
router.get('/requests', requireAuth, async (_req: Request, res: Response) => {
  res.json({ success: true, count: 0, data: [] });
});

/** POST /subgroups/requests — Disabled: Only Zone Admins can create churches directly */
router.post('/requests', requireAuth, async (_req: Request, res: Response) => {
  res.status(403).json({
    success: false,
    error: 'Individual church requests are disabled. Churches can only be created and assigned by Zone Administrators.',
  });
});

/** GET /subgroups - List groups */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const queryZoneId = (req.query.zoneId || req.query.zone_code) as string | undefined;
    const effectiveZoneId = queryZoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const isGlobal =
      queryZoneId === 'all' ||
      queryZoneId === 'global' ||
      (req.tenant?.isHQAdmin && req.tenant?.isGlobalView && !queryZoneId && !req.tenant?.effectiveZoneId);

    const whereClause: any = isGlobal ? {} : { organizationId: effectiveZoneId };

    const groups = await prisma.group.findMany({
      where: whereClause,
      include: {
        _count: {
          select: { memberships: true },
        },
        memberships: {
          where: { role: 'GROUP_ADMIN' },
          include: { user: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const groupMetaMap = new Map<string, any>();
    if (groups.length > 0) {
      try {
        const metaKeys = groups.map((g) => `group_meta_${g.id}`);
        const metaSettings = await prisma.setting.findMany({ where: { key: { in: metaKeys } } });
        for (const s of metaSettings) {
          groupMetaMap.set(s.key.replace('group_meta_', ''), s.value);
        }
      } catch {}
    }

    res.json({
      success: true,
      count: groups.length,
      data: groups.map((g) => shapeGroup(g, groupMetaMap.get(g.id))),
    });
  } catch (err) {
    console.error('[subgroups/ GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load groups' });
  }
});

/** GET /subgroups/:id */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const group = await prisma.group.findUnique({
      where: { id: req.params.id },
      include: {
        _count: {
          select: { memberships: true },
        },
        memberships: {
          where: { role: 'GROUP_ADMIN' },
          include: { user: true },
        },
      },
    });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
    let groupMeta: any = null;
    try {
      const metaRow = await prisma.setting.findUnique({ where: { key: `group_meta_${group.id}` } });
      groupMeta = metaRow?.value || null;
    } catch {}
    res.json({ success: true, data: shapeGroup(group, groupMeta) });
  } catch (err) {
    console.error('[subgroups/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load group' });
  }
});

/** GET /subgroups/:id/members — List members in this group */
router.get('/:id/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = req.query.page ? Math.max(1, parseInt(req.query.page as string, 10)) : undefined;
    const limit = req.query.limit ? Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10))) : (page ? 50 : undefined);
    const skip = page && limit ? (page - 1) * limit : undefined;

    const where = { groupId: id };
    const [total, memberships] = await Promise.all([
      prisma.membership.count({ where }),
      prisma.membership.findMany({
        where,
        include: { user: true },
        skip,
        take: limit,
        orderBy: { joinedAt: 'desc' },
      }),
    ]);

    const metaKeys = memberships.map((m) => `profile_meta_${m.userId}`);
    const metaSettings = await prisma.setting.findMany({ where: { key: { in: metaKeys } } });
    const metaMap = new Map<string, any>();
    metaSettings.forEach((s) => metaMap.set(s.key.replace('profile_meta_', ''), s.value));

    const members = memberships.map((m) => {
      const meta: any = metaMap.get(m.userId) || {};
      const rawRole = (meta?.role || m.role || 'MEMBER').toLowerCase();
      const isUserHq =
        isHQRole(rawRole) ||
        isHQRole(meta?.role) ||
        Boolean(meta?.hasHqAccess) ||
        Boolean(meta?.has_hq_access);
      const isAdmin = rawRole.includes('admin') || rawRole.includes('coord') || rawRole === 'group_admin' || isUserHq;
      const resolvedRole = isUserHq ? 'hq_admin' : (isAdmin ? 'church_admin' : 'member');

      return {
        id: m.id,
        userId: m.userId,
        email: m.user.email,
        name: [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') || m.user.email || 'Member',
        firstName: m.user.firstName,
        lastName: m.user.lastName,
        avatarUrl: m.user.avatarUrl,
        role: resolvedRole,
        isHqAdmin: isUserHq,
        hasHqAccess: isUserHq,
        rawRole: meta?.role || m.role,
        isAdmin,
        status: m.status,
        voicePart: m.voicePart,
        joinedAt: m.joinedAt,
        canAnnotate: Boolean(meta?.canAnnotate),
        can_annotate: Boolean(meta?.canAnnotate),
        canAccessArchive: Boolean(meta?.canSeeArchive || meta?.canAccessArchive || meta?.can_access_archive),
        can_access_archive: Boolean(meta?.canSeeArchive || meta?.canAccessArchive || meta?.can_access_archive),
        canSeeArchive: Boolean(meta?.canSeeArchive || meta?.canAccessArchive || meta?.can_access_archive),
        canAccessPreRehearsal: Boolean(meta?.can_access_pre_rehearsal || meta?.canAccessPreRehearsal),
        can_access_pre_rehearsal: Boolean(meta?.can_access_pre_rehearsal || meta?.canAccessPreRehearsal),
        canAccessOngoing: meta?.can_access_ongoing !== false && meta?.canAccessOngoing !== false,
        can_access_ongoing: meta?.can_access_ongoing !== false && meta?.canAccessOngoing !== false,
        hiddenFeatures: meta?.hiddenFeatures,
      };
    });

    res.json({
      success: true,
      count: members.length,
      total,
      page: page || 1,
      limit: limit || total,
      totalPages: limit ? Math.ceil(total / limit) : 1,
      hasMore: skip !== undefined && limit !== undefined ? skip + memberships.length < total : false,
      data: members,
    });
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
    await detachChurchFromUserMeta(userId, id);

    const membership = await prisma.membership.findFirst({
      where: { userId, groupId: id },
    });

    if (membership) {
      const nextRole = isZonalOrHQAdminRole(membership.role) ? membership.role : 'MEMBER';
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: null, role: nextRole },
      });
    }

    res.json({ success: true, message: 'Member removed from group' });
  } catch (err) {
    console.error('[subgroups/:id/members:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

async function assignCoordinatorToGroup(req: Request, res: Response, logPrefix: string) {
  try {
    const { id } = req.params;
    const { email, userId, identifier } = req.body;

    let targetUser: any = null;
    const lookupId = userId || (!identifier?.includes('@') ? identifier : null);
    const lookupEmail = (email || (identifier?.includes('@') ? identifier : null))?.toLowerCase().trim();

    if (lookupId) {
      targetUser = await prisma.user.findUnique({ where: { id: lookupId } });
    }
    if (!targetUser && lookupEmail) {
      targetUser = await prisma.user.findFirst({ where: { email: lookupEmail } });
    }

    if (!targetUser) return res.status(404).json({ success: false, error: 'User not found' });

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const membership = await prisma.membership.findFirst({
      where: { userId: targetUser.id, organizationId: group.organizationId },
      include: { group: true },
    });

    // Check if targetUser has HQ or Zone Admin status anywhere
    const allUserMemberships = await prisma.membership.findMany({
      where: { userId: targetUser.id },
    });
    const metaKey = `profile_meta_${targetUser.id}`;
    const existingMeta = await prisma.setting.findUnique({ where: { key: metaKey } });
    const currentMeta: any = existingMeta?.value && typeof existingMeta.value === 'object' ? existingMeta.value : {};

    const hasAnyHqRole =
      allUserMemberships.some((m) => isHQRole(m.role)) ||
      isHQRole(currentMeta.role) ||
      Boolean(currentMeta.hasHqAccess) ||
      Boolean(currentMeta.has_hq_access);

    const hasAnyZoneAdminRole =
      allUserMemberships.some((m) => isZonalOrHQAdminRole(m.role)) ||
      isZonalOrHQAdminRole(currentMeta.role);

    let memberRole = 'GROUP_ADMIN';
    if (group.organizationId === 'zone-001' && hasAnyHqRole) {
      memberRole = 'HQ_ADMIN';
    } else if (membership?.role && isZonalOrHQAdminRole(membership.role)) {
      memberRole = membership.role;
    }

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: {
          groupId: id,
          role: group.organizationId === 'zone-001' && hasAnyHqRole ? 'HQ_ADMIN' : memberRole,
        },
      });
    } else {
      await prisma.membership.create({
        data: {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: targetUser.id,
          organizationId: group.organizationId,
          groupId: id,
          role: group.organizationId === 'zone-001' && hasAnyHqRole ? 'HQ_ADMIN' : 'GROUP_ADMIN',
          status: 'ACTIVE',
        },
      });
    }

    // Sync profile_meta for user (preserving existing coordinated churches so multi-church admins keep all churches)
    const churchesMap = new Map<string, { id: string; name: string; zoneId: string }>();
    if (Array.isArray(currentMeta.churches)) {
      for (const c of currentMeta.churches) {
        const cid = String(c?.id || c?.churchId || c?.groupId || '').trim();
        if (cid) {
          churchesMap.set(cid, {
            id: cid,
            name: String(c?.name || c?.churchName || c?.groupName || 'Church'),
            zoneId: String(c?.zoneId || c?.organizationId || group.organizationId),
          });
        }
      }
    }
    if (currentMeta.churchId && !churchesMap.has(String(currentMeta.churchId))) {
      churchesMap.set(String(currentMeta.churchId), {
        id: String(currentMeta.churchId),
        name: String(currentMeta.church || 'Church'),
        zoneId: group.organizationId,
      });
    }
    if (membership?.groupId && membership.group && !churchesMap.has(membership.groupId)) {
      churchesMap.set(membership.groupId, {
        id: membership.groupId,
        name: membership.group.name,
        zoneId: membership.organizationId,
      });
    }
    churchesMap.set(group.id, {
      id: group.id,
      name: group.name,
      zoneId: group.organizationId,
    });

    const preserveMetaRole =
      hasAnyHqRole
        ? 'hq_admin'
        : hasAnyZoneAdminRole
          ? (currentMeta?.role && isZonalOrHQAdminRole(currentMeta.role) ? currentMeta.role : 'zone_admin')
          : 'church_coordinator';

    const updatedMeta = {
      ...currentMeta,
      role: preserveMetaRole,
      hasHqAccess: hasAnyHqRole ? true : Boolean(currentMeta.hasHqAccess),
      has_hq_access: hasAnyHqRole ? true : Boolean(currentMeta.has_hq_access),
      administration: hasAnyHqRole
        ? (currentMeta.administration && currentMeta.administration !== 'Member' ? currentMeta.administration : 'HQ Admin')
        : currentMeta.administration,
      church: group.name,
      churchId: group.id,
      churches: Array.from(churchesMap.values()),
    };
    await prisma.setting.upsert({
      where: { key: metaKey },
      create: { key: metaKey, value: updatedMeta },
      update: { value: updatedMeta },
    });

    // Also persist group_meta_${group.id} so GET /subgroups knows ALL coordinators for this church
    const coordinatorName =
      [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ') || targetUser.email || 'Coordinator';
    const groupMetaKey = `group_meta_${group.id}`;
    const existingGroupMetaRow = await prisma.setting.findUnique({ where: { key: groupMetaKey } }).catch(() => null);
    const existingGroupMeta: any = existingGroupMetaRow?.value && typeof existingGroupMetaRow.value === 'object' ? existingGroupMetaRow.value : {};

    const coordListMap = new Map<string, { id: string; name: string; email: string }>();
    if (Array.isArray(existingGroupMeta.coordinators)) {
      for (const c of existingGroupMeta.coordinators) {
        const cid = String(c?.id || c?.userId || '').trim();
        if (cid) {
          coordListMap.set(cid, {
            id: cid,
            name: String(c?.name || c?.email || 'Coordinator'),
            email: String(c?.email || ''),
          });
        }
      }
    }
    if (existingGroupMeta.coordinatorId && !coordListMap.has(String(existingGroupMeta.coordinatorId))) {
      coordListMap.set(String(existingGroupMeta.coordinatorId), {
        id: String(existingGroupMeta.coordinatorId),
        name: String(existingGroupMeta.coordinatorName || existingGroupMeta.coordinatorEmail || 'Coordinator'),
        email: String(existingGroupMeta.coordinatorEmail || ''),
      });
    }
    coordListMap.set(targetUser.id, {
      id: targetUser.id,
      name: coordinatorName,
      email: targetUser.email || '',
    });

    const allCoords = Array.from(coordListMap.values());
    const primaryCoord = allCoords[0];

    const groupMetaValue = {
      ...existingGroupMeta,
      coordinatorId: primaryCoord?.id || targetUser.id,
      coordinatorName: primaryCoord?.name || coordinatorName,
      coordinatorEmail: primaryCoord?.email || targetUser.email,
      coordinators: allCoords,
      updatedAt: new Date().toISOString(),
    };
    await prisma.setting.upsert({
      where: { key: groupMetaKey },
      create: { key: groupMetaKey, value: groupMetaValue },
      update: { value: groupMetaValue },
    });

    res.json({ success: true, message: 'Coordinator assigned successfully' });
  } catch (err) {
    console.error(logPrefix, err);
    res.status(500).json({ success: false, error: 'Failed to assign coordinator' });
  }
}

/** POST /subgroups/:id/assign-coordinator */
router.post('/:id/assign-coordinator', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  await assignCoordinatorToGroup(req, res, '[subgroups/:id/assign-coordinator]');
});

/** POST /subgroups/:id/coordinators — Alias for assign-coordinator */
router.post('/:id/coordinators', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  await assignCoordinatorToGroup(req, res, '[subgroups/:id/coordinators]');
});

async function detachChurchFromUserMeta(userId: string, groupId: string) {
  try {
    const metaKey = `profile_meta_${userId}`;
    const existingMeta = await prisma.setting.findUnique({ where: { key: metaKey } });
    const currentMeta: any = existingMeta?.value && typeof existingMeta.value === 'object' ? existingMeta.value : null;
    if (!currentMeta) return;

    const remainingChurches = Array.isArray(currentMeta.churches)
      ? currentMeta.churches.filter((c: any) => String(c?.id || c?.churchId || c?.groupId || '') !== groupId)
      : [];

    const nextPrimary = remainingChurches[0] || null;
    const isCurrentPrimary = String(currentMeta.churchId || '') === groupId;
    const isStillCoordinator = remainingChurches.length > 0;

    const userMems = await prisma.membership.findMany({ where: { userId } }).catch(() => []);
    const isUserHq =
      userMems.some((m) => isHQRole(m.role)) ||
      isHQRole(currentMeta.role) ||
      Boolean(currentMeta.hasHqAccess) ||
      Boolean(currentMeta.has_hq_access);
    const isUserZoneAdmin =
      userMems.some((m) => isZonalOrHQAdminRole(m.role)) ||
      isZonalOrHQAdminRole(currentMeta.role);

    const nextRole =
      isUserHq
        ? 'hq_admin'
        : isUserZoneAdmin
          ? 'zone_admin'
          : !isStillCoordinator && String(currentMeta.role || '').toLowerCase() === 'church_coordinator'
            ? 'member'
            : currentMeta.role;

    const updatedMeta = {
      ...currentMeta,
      role: nextRole,
      hasHqAccess: isUserHq ? true : Boolean(currentMeta.hasHqAccess),
      has_hq_access: isUserHq ? true : Boolean(currentMeta.has_hq_access),
      administration: isUserHq
        ? (currentMeta.administration && currentMeta.administration !== 'Member' ? currentMeta.administration : 'HQ Admin')
        : currentMeta.administration,
      churchId: isCurrentPrimary ? (nextPrimary?.id || null) : currentMeta.churchId,
      church: isCurrentPrimary ? (nextPrimary?.name || null) : currentMeta.church,
      churches: remainingChurches,
    };

    await prisma.setting.upsert({
      where: { key: metaKey },
      create: { key: metaKey, value: updatedMeta },
      update: { value: updatedMeta },
    });

    // If their membership in this zone pointed to groupId as GROUP_ADMIN, update it to nextPrimary or demote to MEMBER
    const mem = await prisma.membership.findFirst({
      where: { userId, groupId },
    });
    if (mem) {
      let nextRoleForMem = mem.role;
      if (mem.organizationId === 'zone-001' && isUserHq) {
        nextRoleForMem = 'HQ_ADMIN';
      } else if (isZonalOrHQAdminRole(mem.role)) {
        nextRoleForMem = mem.role;
      } else {
        nextRoleForMem = nextPrimary ? 'GROUP_ADMIN' : 'MEMBER';
      }
      await prisma.membership.update({
        where: { id: mem.id },
        data: {
          groupId: nextPrimary?.id || (mem.organizationId === 'zone-001' ? null : mem.groupId),
          role: nextRoleForMem,
        },
      });
    }
  } catch (err) {
    console.warn('[detachChurchFromUserMeta]', err);
  }
}

/** DELETE /subgroups/:id/coordinators & POST /subgroups/:id/remove-coordinator — Unassign church coordinator(s) */
const handleRemoveCoordinator = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const specificUserId = String(req.body?.userId || req.query?.userId || '').trim();
    const groupMetaKey = `group_meta_${id}`;
    const groupMetaRow = await prisma.setting.findUnique({ where: { key: groupMetaKey } }).catch(() => null);
    const groupMeta: any = groupMetaRow?.value && typeof groupMetaRow.value === 'object' ? groupMetaRow.value : {};

    if (specificUserId) {
      // Unassign ONLY the specified user, keeping any co-coordinators intact
      await detachChurchFromUserMeta(specificUserId, id);

      const remainingCoords = Array.isArray(groupMeta.coordinators)
        ? groupMeta.coordinators.filter((c: any) => String(c?.id || c?.userId || '') !== specificUserId)
        : [];

      if (remainingCoords.length > 0) {
        const nextLead = remainingCoords[0];
        await prisma.setting.upsert({
          where: { key: groupMetaKey },
          create: {
            key: groupMetaKey,
            value: {
              ...groupMeta,
              coordinatorId: nextLead.id,
              coordinatorName: nextLead.name,
              coordinatorEmail: nextLead.email,
              coordinators: remainingCoords,
              updatedAt: new Date().toISOString(),
            },
          },
          update: {
            value: {
              ...groupMeta,
              coordinatorId: nextLead.id,
              coordinatorName: nextLead.name,
              coordinatorEmail: nextLead.email,
              coordinators: remainingCoords,
              updatedAt: new Date().toISOString(),
            },
          },
        });
      } else if (String(groupMeta.coordinatorId || '') === specificUserId) {
        await prisma.setting.delete({ where: { key: groupMetaKey } }).catch(() => {});
      }
    } else {
      // Unassign all coordinators of this church
      const adminMemberships = await prisma.membership.findMany({
        where: { groupId: id, role: 'GROUP_ADMIN' },
      });

      const targetUserIds = new Set<string>();
      if (groupMeta?.coordinatorId) targetUserIds.add(String(groupMeta.coordinatorId));
      if (Array.isArray(groupMeta?.coordinators)) {
        for (const c of groupMeta.coordinators) {
          if (c?.id) targetUserIds.add(String(c.id));
        }
      }
      for (const m of adminMemberships) {
        targetUserIds.add(m.userId);
      }

      for (const uid of targetUserIds) {
        await detachChurchFromUserMeta(uid, id);
      }

      await prisma.setting.delete({ where: { key: groupMetaKey } }).catch(() => {});
    }

    res.json({ success: true, message: 'Coordinator unassigned successfully' });
  } catch (err) {
    console.error('[subgroups/:id/remove-coordinator]', err);
    res.status(500).json({ success: false, error: 'Failed to remove coordinator' });
  }
};

router.delete('/:id/coordinators', requireAuth, requireTenantAdmin, handleRemoveCoordinator);
router.post('/:id/remove-coordinator', requireAuth, requireTenantAdmin, handleRemoveCoordinator);

/** POST /subgroups/:id/approve — Approve pending church/subgroup */
router.post('/:id/approve', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const group = await prisma.group.update({
      where: { id },
      data: { status: 'active' },
    });
    res.json({ success: true, message: 'Group approved', data: shapeGroup(group) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to approve group' });
  }
});

/** POST /subgroups/:id/reject — Reject pending church/subgroup */
router.post('/:id/reject', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const group = await prisma.group.update({
      where: { id },
      data: { status: 'rejected' },
    });
    res.json({ success: true, message: 'Group rejected', data: shapeGroup(group) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to reject group' });
  }
});

function shapeSubgroupMember(m: any) {
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

/** GET /subgroups/members — List members via query param ?subGroupId=... */
router.get('/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId } = req.query as Record<string, string>;
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId) {
      return res.status(400).json({ success: false, error: 'subGroupId is required' });
    }
    const memberships = await prisma.membership.findMany({
      where: { groupId: targetGroupId },
      include: { user: true, organization: true, group: true },
      orderBy: { joinedAt: 'desc' },
    });

    res.json({
      success: true,
      count: memberships.length,
      data: memberships.map(shapeSubgroupMember),
    });
  } catch (err) {
    console.error('[subgroups/members:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load group members' });
  }
});

/** POST /subgroups/members — Add member to subgroup with body { subGroupId, userId } */
router.post('/members', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId, userId } = req.body;
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId || !userId) return res.status(400).json({ success: false, error: 'subGroupId and userId are required' });

    const group = await prisma.group.findUnique({ where: { id: targetGroupId } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: group.organizationId },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: targetGroupId },
      });
    } else {
      await prisma.membership.create({
        data: {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId,
          organizationId: group.organizationId,
          groupId: targetGroupId,
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });
    }

    res.json({ success: true, message: 'Member added to group' });
  } catch (err) {
    console.error('[subgroups/members:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to add member' });
  }
});

/** DELETE /subgroups/members — Remove member from subgroup with query ?subGroupId=...&userId=... */
router.delete('/members', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId, userId } = req.query as Record<string, string>;
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId || !userId) return res.status(400).json({ success: false, error: 'subGroupId and userId are required' });

    await detachChurchFromUserMeta(userId, targetGroupId);

    const membership = await prisma.membership.findFirst({
      where: { userId, groupId: targetGroupId },
    });

    if (membership) {
      const nextRole = isZonalOrHQAdminRole(membership.role) ? membership.role : 'MEMBER';
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: null, role: nextRole },
      });
    }

    res.json({ success: true, message: 'Member removed from group' });
  } catch (err) {
    console.error('[subgroups/members:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

/** POST /subgroups - Create group (Zone Admin & HQ Admin only) */
router.post('/', requireAuth, requireZoneOrHqAdmin, async (req: Request, res: Response) => {
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

/** PATCH /subgroups/:id - Update group (Zone Admin & HQ Admin only) */
router.patch('/:id', requireAuth, requireZoneOrHqAdmin, async (req: Request, res: Response) => {
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
      include: {
        _count: { select: { memberships: true } },
        memberships: {
          where: { role: 'GROUP_ADMIN' },
          include: { user: true },
          take: 1,
        },
      },
    });

    // If name changed, sync coordinator's profile_meta.churches so their switcher shows the updated church name
    let groupMeta: any = null;
    try {
      const metaRow = await prisma.setting.findUnique({ where: { key: `group_meta_${id}` } });
      groupMeta = metaRow?.value || null;
      if (updateData.name) {
        const coordId = groupMeta?.coordinatorId || updated.memberships?.[0]?.userId;
        if (coordId) {
          const pMetaKey = `profile_meta_${coordId}`;
          const pRow = await prisma.setting.findUnique({ where: { key: pMetaKey } });
          if (pRow?.value && typeof pRow.value === 'object') {
            const pVal: any = { ...(pRow.value as Record<string, any>) };
            if (String(pVal.churchId || '') === id) {
              pVal.church = updateData.name;
            }
            if (Array.isArray(pVal.churches)) {
              pVal.churches = pVal.churches.map((c: any) =>
                String(c?.id || c?.churchId || '') === id ? { ...c, name: updateData.name } : c
              );
            }
            await prisma.setting.update({ where: { key: pMetaKey }, data: { value: pVal } });
          }
        }
      }
    } catch {}

    res.json({ success: true, data: shapeGroup(updated, groupMeta) });
  } catch (err: any) {
    console.error('[subgroups PATCH]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update group' });
  }
});

/** DELETE /subgroups/:id (Zone Admin & HQ Admin only) */
router.delete('/:id', requireAuth, requireZoneOrHqAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // 1. Find coordinator and all members referencing this group to clean up their profile_meta & memberships
    const groupMetaKey = `group_meta_${id}`;
    const [groupMetaRow, groupMemberships] = await Promise.all([
      prisma.setting.findUnique({ where: { key: groupMetaKey } }).catch(() => null),
      prisma.membership.findMany({ where: { groupId: id } }).catch(() => []),
    ]);

    const affectedUserIds = new Set<string>();
    const groupMeta: any = groupMetaRow?.value || {};
    if (groupMeta?.coordinatorId) affectedUserIds.add(String(groupMeta.coordinatorId));
    for (const m of groupMemberships) {
      affectedUserIds.add(m.userId);
    }

    for (const uid of affectedUserIds) {
      await detachChurchFromUserMeta(uid, id);
    }

    // 2. Detach remaining memberships, programs, songs, and group_meta before deleting the group
    await Promise.all([
      prisma.membership.updateMany({ where: { groupId: id }, data: { groupId: null } }).catch(() => {}),
      prisma.program.deleteMany({ where: { groupId: id } }).catch(() => {}),
      prisma.song.updateMany({ where: { groupId: id }, data: { groupId: null } }).catch(() => {}),
      prisma.setting.delete({ where: { key: groupMetaKey } }).catch(() => {}),
    ]);

    await prisma.group.delete({ where: { id } });
    res.json({ success: true, message: 'Group deleted successfully' });
  } catch (err: any) {
    console.error('[subgroups DELETE]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete group' });
  }
});

/** POST /subgroups/songs — Create a new subgroup song */
router.post('/songs', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const body = req.body || {};
    const { title, key, writer, category, tempo, leadSinger, lyrics, audioFile, audioUrl, subGroupId, zoneId } = body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Song title is required' });
    }

    const id = `sgsong_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveOrgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    const created = await prisma.song.create({
      data: {
        id,
        title: title.trim(),
        key: key ? String(key).trim() : null,
        writer: writer ? String(writer).trim() : (auth.firstName || 'Member'),
        category: category ? String(category).trim() : 'Church Songs',
        tempo: tempo ? String(tempo).trim() : null,
        leadSinger: leadSinger ? String(leadSinger).trim() : null,
        lyrics: lyrics ? String(lyrics).trim() : null,
        audioFile: audioFile || audioUrl || null,
        organizationId: effectiveOrgId,
        groupId: subGroupId || null,
        status: 'active',
      },
    });

    res.status(201).json({ success: true, message: 'Song created successfully', data: created });
  } catch (err: any) {
    console.error('[subgroups:songs:create]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to create subgroup song' });
  }
});

/** PATCH /subgroups/songs/:id — Update subgroup song */
router.patch('/songs/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.status !== undefined) data.status = body.status;
    if (body.isActive !== undefined) data.status = body.isActive ? 'active' : 'inactive';
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.audioFile !== undefined || body.audioUrl !== undefined) data.audioFile = body.audioFile || body.audioUrl;

    const updated = await prisma.song.update({ where: { id }, data });
    res.json({ success: true, message: 'Subgroup song updated', data: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update song' });
  }
});

/** DELETE /subgroups/songs/:id — Delete subgroup song */
router.delete('/songs/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.song.delete({ where: { id } });
    res.json({ success: true, message: 'Subgroup song deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete song' });
  }
});

/** PATCH /subgroups/praise-nights/:id — Update subgroup program/rehearsal */
router.patch('/praise-nights/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const data: any = {};
    if (body.name !== undefined || body.title !== undefined) data.name = body.name || body.title;
    if (body.date !== undefined) data.date = body.date;
    if (body.status !== undefined || body.category !== undefined || body.isActive !== undefined || body.isArchived !== undefined) {
      const candidateStage = (body.category || body.status || '').toLowerCase().trim();
      const isOngoing = candidateStage === 'ongoing' || candidateStage === 'active' || body.isActive === true;
      const isArchive = candidateStage === 'archive' || candidateStage === 'archived' || candidateStage === 'completed' || body.isArchived === true;
      const isDraft = candidateStage === 'draft';
      const isPreReh = candidateStage === 'pre-rehearsal' || candidateStage === 'pre_rehearsal';

      const nextIsActive = typeof body.isActive === 'boolean' ? body.isActive : isOngoing;
      const nextIsArchived = typeof body.isArchived === 'boolean' ? body.isArchived : isArchive;
      const nextStage = nextIsActive ? 'ongoing' : nextIsArchived ? 'archive' : isDraft ? 'draft' : isPreReh ? 'pre-rehearsal' : (body.status || body.category || 'pre-rehearsal');

      data.status = nextStage;
      data.category = nextStage;
      data.isActive = nextIsActive;
      data.isArchived = nextIsArchived;
    }
    if (body.location !== undefined) data.location = body.location;
    if (body.bannerImage !== undefined) data.bannerImage = body.bannerImage;

    if (Array.isArray(body.songIds)) {
      const uniqueSongIds: string[] = Array.from(new Set<string>(body.songIds.map(String)));
      // SAFEGUARD: Check existing song count to prevent accidental bulk-drop / race-condition wipes
      const currentCount = await prisma.programSong.count({ where: { programId: id } });
      const isSuspectBulkDrop = currentCount > 3 && uniqueSongIds.length <= 1 && !body.confirmTruncate;

      if (isSuspectBulkDrop) {
        console.warn(`[SAFETY GUARD BLOCKED] Refused to drop ${currentCount} songs down to ${uniqueSongIds.length} songs for subgroup program ${id} without confirmTruncate flag.`);
        const existingLinks = await prisma.programSong.findMany({
          where: { programId: id },
          orderBy: { order: 'asc' },
        });
        const existingIdSet = new Set(existingLinks.map(l => l.songId));
        let maxOrder = existingLinks.reduce((max, l) => Math.max(max, l.order || 0), 0);

        for (const sId of uniqueSongIds) {
          if (!existingIdSet.has(sId)) {
            maxOrder += 1;
            await prisma.programSong.create({
              data: { programId: id, songId: sId, order: maxOrder },
            });
          }
        }
      } else {
        await prisma.programSong.deleteMany({ where: { programId: id } });
        if (uniqueSongIds.length > 0) {
          await prisma.programSong.createMany({
            data: uniqueSongIds.map((sId: string, idx: number) => ({
              programId: id,
              songId: sId,
              order: idx + 1,
            })),
          });
        }
      }
    }

    const updated = await prisma.program.update({ where: { id }, data });
    res.json({ success: true, message: 'Subgroup program updated', data: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update subgroup program' });
  }
});

/** GET /subgroups/songs & /subgroups/:subgroupId/songs — List subgroup songs */
router.get(['/songs', '/:subgroupId/songs'], requireAuth, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId } = req.query as Record<string, string>;
    const targetGroupId = (req.params as any).subgroupId || subGroupId || groupId;

    const where: any = {};
    if (targetGroupId) {
      where.groupId = targetGroupId;
    } else {
      where.groupId = { not: null };
    }

    const songs = await prisma.song.findMany({
      where,
      orderBy: { title: 'asc' },
    });

    res.json({ success: true, count: songs.length, data: songs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to load subgroup songs' });
  }
});

/** POST /subgroups/songs/import — Import songs into subgroup */
router.post('/songs/import', requireAuth, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId, songIds = [] } = req.body;
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId || !Array.isArray(songIds)) {
      return res.status(400).json({ success: false, error: 'subGroupId and songIds array are required' });
    }

    const group = await prisma.group.findUnique({ where: { id: targetGroupId } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const songs = await prisma.song.findMany({ where: { id: { in: songIds } } });
    for (const song of songs) {
      const newId = `subsong_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await prisma.song.create({
        data: {
          id: newId,
          title: song.title,
          writer: song.writer,
          key: song.key,
          tempo: song.tempo,
          lyrics: song.lyrics,
          solfas: song.solfas,
          audioFile: song.audioFile,
          status: 'active',
          organizationId: group.organizationId,
          groupId: targetGroupId,
          category: 'Church Song',
        },
      });
    }

    res.json({ success: true, message: `${songs.length} song(s) imported into church.` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to import songs' });
  }
});

/** GET /subgroups/praise-nights & /subgroups/member-rehearsals — List subgroup rehearsals/programs */
router.get(['/praise-nights', '/member-rehearsals'], requireAuth, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId } = req.query as Record<string, string>;
    const targetGroupId = subGroupId || groupId;

    const where: any = {};
    if (targetGroupId) {
      where.groupId = targetGroupId;
    } else {
      where.groupId = { not: null };
    }

    const programs = await prisma.program.findMany({
      where,
      include: {
        programSongs: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { date: 'desc' },
    });

    res.json({
      success: true,
      count: programs.length,
      data: programs.map((p) => {
        const rawStatus = (p.status || p.category || '').toLowerCase().trim();
        const rawCat = (p.category || '').toLowerCase().trim();
        const isActive = Boolean(p.isActive || rawStatus === 'active' || rawStatus === 'ongoing' || rawCat === 'ongoing');
        const isArchived = Boolean(p.isArchived || rawStatus === 'archived' || rawStatus === 'archive' || rawStatus === 'completed' || rawCat === 'archive');
        const isDraft = rawStatus === 'draft' || rawCat === 'draft';
        const resolvedStage = isActive ? 'ongoing' : isArchived ? 'archive' : isDraft ? 'draft' : 'pre-rehearsal';

        return {
          ...p,
          subGroupId: p.groupId,
          status: resolvedStage,
          category: resolvedStage,
          stage: resolvedStage,
          isActive,
          isArchived,
          songs: p.programSongs.map((ps) => ps.song),
          songCount: p.programSongs.length,
        };
      }),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to load subgroup programs' });
  }
});

/** POST /subgroups/praise-nights — Create subgroup rehearsal/program */
router.post('/praise-nights', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { name, title, date, location, category, status, subGroupId, groupId, songIds = [] } = req.body;
    const uniqueSongIds = Array.from(new Set(Array.isArray(songIds) ? songIds.map(String) : []));
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId) return res.status(400).json({ success: false, error: 'subGroupId is required' });

    const group = await prisma.group.findUnique({ where: { id: targetGroupId } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const progId = req.body.id || `subprog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveCategory = category || (status === 'ongoing' ? 'ongoing' : 'pre-rehearsal');

    const created = await prisma.program.create({
      data: {
        id: progId,
        name: (name || title || 'Rehearsal').trim(),
        date: date || new Date().toISOString().split('T')[0],
        category: effectiveCategory,
        status: status || effectiveCategory,
        location: location || null,
        organizationId: group.organizationId,
        groupId: targetGroupId,
        ...(uniqueSongIds.length > 0
          ? {
              programSongs: {
          create: uniqueSongIds.map((sId: string, idx: number) => ({
                  songId: sId,
                  order: idx + 1,
                })),
              },
            }
          : {}),
      },
      include: {
        programSongs: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    res.status(201).json({ success: true, message: 'Subgroup rehearsal created', data: created });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to create subgroup rehearsal' });
  }
});

export default router;
