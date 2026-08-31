import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';

const router = Router();
const idSchema = z.string().min(1).max(200);

function normalizeTenantId(value: unknown): string {
  return String(value || '').replace(/-/g, '').toLowerCase();
}

function canAccessSubgroup(req: any, row: any): boolean {
  const tenant = req.tenant;
  if (tenant?.isHQAdmin) return true;

  const raw = (row.rawData && typeof row.rawData === 'object' ? row.rawData : {}) as Record<string, any>;
  const subgroupZone = normalizeTenantId(row.zoneId || raw.zoneId || raw.zone_id);
  const tenantZone = normalizeTenantId(tenant?.effectiveZoneId);
  if (!subgroupZone || !tenantZone || subgroupZone !== tenantZone) return false;

  return !tenant?.effectiveChurchId || row.id === tenant.effectiveChurchId;
}

function shapeSubgroup(row: any) {
  const merged = mergeRawRow(row);
  const memberIds = Array.isArray(merged.memberIds)
    ? merged.memberIds
    : Array.isArray(merged.member_ids)
      ? merged.member_ids
      : [];
  return {
    ...merged,
    id: row.id,
    name: row.name ?? (merged.name as string | undefined),
    zoneId: row.zoneId ?? (merged.zoneId as string | undefined) ?? (merged.zone_id as string | undefined),
    coordinatorId:
      (merged.coordinatorId as string | undefined) ||
      (merged.coordinator_id as string | undefined) ||
      row.coordinatorId,
    coordinatorName:
      (merged.coordinatorName as string | undefined) ||
      (merged.coordinator_name as string | undefined) ||
      row.coordinatorName,
    coordinatorEmail:
      (merged.coordinatorEmail as string | undefined) ||
      (merged.coordinator_email as string | undefined),
    memberIds,
    type: row.type || (merged.type as string | undefined) || 'church',
    status: (merged.status as string | undefined) || row.status || 'active',
    description: row.description ?? (merged.description as string | undefined),
  };
}

/** GET /subgroups/mine */
router.get('/mine', requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM subgroups
       WHERE raw_data->>'coordinatorId' = $1
          OR raw_data->>'coordinator_id' = $1
          OR raw_data->>'createdBy' = $1
          OR raw_data->>'created_by' = $1
          OR (raw_data::jsonb -> 'memberIds') ? $1
          OR (raw_data::jsonb -> 'member_ids') ? $1`,
      userId,
    );
    res.json({ success: true, data: rows.map(shapeSubgroup) });
  } catch (err) {
    console.error('[subgroups/mine]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /subgroups/member-rehearsals */
router.get('/member-rehearsals', requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const sgs = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM subgroups
       WHERE raw_data->>'coordinatorId' = $1
          OR raw_data->>'coordinator_id' = $1
          OR (raw_data::jsonb -> 'memberIds') ? $1
          OR (raw_data::jsonb -> 'member_ids') ? $1`,
      userId,
    );
    if (sgs.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    const sgIds = sgs.map(sg => sg.id);
    const rows = await prisma.program.findMany({
      where: {
        OR: [
          { subgroupId: { in: sgIds } },
          { rawData: { path: ['subGroupId'], string_contains: '' } },
        ]
      },
    });
    res.json({ success: true, data: rows.map(mergeRawRow) });
  } catch (err) {
    console.error('[subgroups/member-rehearsals]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /subgroups/coordinated */
router.get('/coordinated', requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM subgroups
       WHERE raw_data->>'coordinatorId' = $1
          OR raw_data->>'coordinator_id' = $1
          OR raw_data->>'createdBy' = $1
          OR raw_data->>'created_by' = $1`,
      userId,
    );
    const data = rows.map(shapeSubgroup);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[subgroups/coordinated]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.get('/:id/songs', requireAuth, async (req, res) => {
  try {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }
    const subgroup = await prisma.subgroup.findUnique({ where: { id: parsed.data } });
    if (!subgroup) {
      res.status(404).json({ success: false, error: 'Subgroup not found' });
      return;
    }
    if (!canAccessSubgroup(req, subgroup)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    const rows = await prisma.song.findMany({
      where: {
        OR: [
          { subgroupId: parsed.data },
          { rawData: { path: ['subGroupId'], equals: parsed.data } },
          { rawData: { path: ['sub_group_id'], equals: parsed.data } },
        ]
      }
    });
    res.json({
      success: true,
      data: rows.map((row) => mergeRawRow(row)),
    });
  } catch (err) {
    console.error('[subgroups/:id/songs]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.get('/:id/praise-nights', requireAuth, async (req, res) => {
  try {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }
    const subgroup = await prisma.subgroup.findUnique({ where: { id: parsed.data } });
    if (!subgroup) {
      res.status(404).json({ success: false, error: 'Subgroup not found' });
      return;
    }
    if (!canAccessSubgroup(req, subgroup)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    const rows = await prisma.program.findMany({
      where: {
        OR: [
          { subgroupId: parsed.data },
          { rawData: { path: ['subGroupId'], equals: parsed.data } },
          { rawData: { path: ['sub_group_id'], equals: parsed.data } },
        ]
      },
    });
    res.json({
      success: true,
      data: rows.map((row: any) => mergeRawRow(row)),
    });
  } catch (err) {
    console.error('[subgroups/:id/praise-nights]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.get('/', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    const effectiveZoneId = req.tenant?.effectiveZoneId !== undefined
      ? req.tenant.effectiveZoneId
      : ((req.query.zoneId && req.query.zoneId !== 'all') ? String(req.query.zoneId) : (!isHqAdmin ? (auth.zoneId as string | null) : null));

    let rows: any[] = [];
    if (effectiveZoneId && effectiveZoneId !== 'all') {
      const withoutHyphen = effectiveZoneId.replace(/-/g, '').toLowerCase();
      const withHyphen = effectiveZoneId.includes('-') ? effectiveZoneId.toLowerCase() : effectiveZoneId.toLowerCase().replace(/^zone(\d+)$/, 'zone-$1');

      if (isHqAdmin) {
        rows = await prisma.$queryRawUnsafe<any[]>(
          `SELECT * FROM subgroups
           WHERE lower(replace(COALESCE(zone_id, ''), '-', '')) = $1
              OR lower(COALESCE(zone_id, '')) = $2
           ORDER BY created_at DESC`,
          withoutHyphen,
          withHyphen,
        );
      } else {
        rows = await prisma.$queryRawUnsafe<any[]>(
          `SELECT * FROM subgroups
           WHERE status = 'approved'
             AND (lower(replace(COALESCE(zone_id, ''), '-', '')) = $1
               OR lower(COALESCE(zone_id, '')) = $2)
           ORDER BY created_at DESC`,
          withoutHyphen,
          withHyphen,
        );
      }
    } else {
      if (isHqAdmin) {
        rows = await prisma.subgroup.findMany({ orderBy: { createdAt: 'desc' } });
      } else {
        rows = await prisma.subgroup.findMany({
          where: { status: 'approved' },
          orderBy: { createdAt: 'desc' },
        });
      }
    }

    res.json({ success: true, count: rows.length, data: rows.map(shapeSubgroup) });
  } catch (err) {
    console.error('[subgroups/ GET]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid id' });
      return;
    }
    const row = await prisma.subgroup.findUnique({ where: { id: parsed.data } });
    if (!row) {
      res.status(404).json({ success: false, error: 'Subgroup not found' });
      return;
    }
    if (!canAccessSubgroup(req, row)) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    res.json({ success: true, data: shapeSubgroup(row) });
  } catch (err) {
    console.error('[subgroups/:id GET]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const userId = auth.userId as string;
    const { name, zoneId, description = '', coordinatorId, coordinatorName = '', type = 'church', estimatedMembers, memberIds } = req.body || {};

    if (!name?.trim()) {
      res.status(400).json({ success: false, error: 'Subgroup name is required' });
      return;
    }

    const subgroupId = `sg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const finalStatus = (auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'zone_admin') ? 'approved' : 'pending';

    const rawData = {
      id: subgroupId,
      name: name.trim(),
      description: description.trim(),
      type,
      coordinatorName: coordinatorName.trim() || auth.email || 'Coordinator',
      coordinatorId: coordinatorId || userId,
      zoneId: zoneId || 'global',
      estimatedMembers: Number(estimatedMembers) || 10,
      memberIds: Array.isArray(memberIds) && memberIds.length > 0 ? memberIds : [userId],
      status: finalStatus,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };

    await prisma.subgroup.create({
      data: {
        id: subgroupId,
        name: name.trim(),
        organizationId: zoneId || 'zone-001',
        type,
        status: finalStatus,
        rawData,
      },
    });
    res.json({ success: true, data: shapeSubgroup({ id: subgroupId, name: name.trim(), organizationId: zoneId || 'zone-001', type, status: finalStatus, coordinatorId: coordinatorId || userId, coordinatorName: coordinatorName.trim() || auth.email || 'Coordinator', createdBy: userId, rawData }) });
  } catch (err: any) {
    console.error('[subgroups/ POST]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch subgroups' });
  }
});

/** POST /subgroups & POST /subgroups/requests — Create a new Church/Subgroup or request approval */
const handleCreateSubgroup = async (req: any, res: any) => {
  try {
    const auth = res.locals.auth;
    const userId = auth.userId as string;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    const isZoneAdmin = auth.role === 'zone_admin';

    const {
      name,
      type = 'church',
      description = '',
      coordinatorName = '',
      coordinatorEmail = '',
      coordinatorId = userId,
      zoneId = auth.zoneId || 'zone-001',
      estimatedMembers = 10,
      memberIds = [userId],
      status: requestedStatus,
    } = req.body || {};

    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: 'Church / Group name is required' });
      return;
    }

    const finalStatus = (isHqAdmin || isZoneAdmin) ? (requestedStatus || 'active') : 'pending';
    const subgroupId = `sg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveOrgId = zoneId && zoneId !== 'global' ? zoneId : 'zone-001';

    const rawData = {
      id: subgroupId,
      name: name.trim(),
      type,
      description: description.trim(),
      coordinatorName: coordinatorName.trim() || auth.email || 'Coordinator',
      coordinatorEmail: coordinatorEmail.trim() || auth.email || '',
      coordinatorId: coordinatorId || userId,
      zoneId: effectiveOrgId,
      estimatedMembers: Number(estimatedMembers) || 10,
      memberIds: Array.isArray(memberIds) && memberIds.length > 0 ? memberIds : [userId],
      status: finalStatus,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };

    await prisma.subgroup.create({
      data: {
        id: subgroupId,
        name: name.trim(),
        organizationId: effectiveOrgId,
        type,
        status: finalStatus,
        rawData,
      },
    });

    if (finalStatus === 'pending') {
      const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await prisma.broadcastNotification.create({
        data: {
          id: notifId,
          title: 'New Church Approval Request',
          body: `${rawData.coordinatorName} requested to register "${name.trim()}" in ${zoneId}.`,
          message: `${rawData.coordinatorName} requested to register "${name.trim()}" in ${zoneId}.`,
          type: 'church_request',
          organizationId: effectiveOrgId,
          createdAt: new Date(),
          rawData: {
            subgroupId,
            requesterId: userId,
            type: 'church_request',
            link: '/admin?section=Churches',
          },
        },
      }).catch(err => console.error('[subgroups] Admin notif error:', err));

      const userNotifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await prisma.broadcastNotification.create({
        data: {
          id: userNotifId,
          title: 'Church Request Submitted',
          body: `Your request to register "${name.trim()}" has been received and is pending admin approval.`,
          message: `Your request to register "${name.trim()}" has been received and is pending admin approval.`,
          type: 'church_request',
          organizationId: effectiveOrgId,
          createdAt: new Date(),
          rawData: {
            subgroupId,
            status: 'pending',
            targetUserId: userId,
          },
        },
      }).catch(err => console.error('[subgroups] User notif error:', err));
    }

    res.json({
      success: true,
      message: finalStatus === 'active' ? 'Church created successfully' : 'Church request submitted for review',
      data: shapeSubgroup({
        id: subgroupId,
        name: name.trim(),
        zoneId: zoneId || 'global',
        description: description.trim(),
        type,
        status: finalStatus,
        coordinatorId: coordinatorId || userId,
        coordinatorName: coordinatorName.trim() || auth.email || 'Coordinator',
        createdBy: userId,
        rawData,
      } as any),
    });
  } catch (err: any) {
    console.error('[subgroups/ POST]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to create church' });
  }
};

router.post('/', requireAuth, handleCreateSubgroup);
router.post('/requests', requireAuth, handleCreateSubgroup);

router.post('/:id/approve', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const row = await prisma.subgroup.findUnique({ where: { id } });
    if (!row) {
      res.status(404).json({ success: false, error: 'Church not found' });
      return;
    }

    const raw = (row.rawData && typeof row.rawData === 'object' && !Array.isArray(row.rawData)
      ? row.rawData
      : {}) as Record<string, any>;
    raw.status = 'active';

    await prisma.subgroup.update({
      where: { id },
      data: {
        status: 'active',
        rawData: raw,
      },
    });

    const targetUser = raw.coordinatorId || raw.createdBy;
    if (targetUser) {
      const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await prisma.broadcastNotification.create({
        data: {
          id: notifId,
          title: 'Church Approved 🎉',
          body: `Your church "${row.name || raw.name}" has been approved by admin!`,
          message: `Your church "${row.name || raw.name}" has been approved by admin!`,
          type: 'church_approved',
          organizationId: row.organizationId,
          createdAt: new Date(),
          rawData: { subgroupId: id, status: 'active', targetUserId: targetUser },
        },
      }).catch(err => console.error('[subgroups/approve] notif error:', err));
    }

    res.json({ success: true, message: 'Church approved successfully' });
  } catch (err: any) {
    console.error('[subgroups/:id/approve]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to approve church' });
  }
});

router.post('/:id/reject', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    const row = await prisma.subgroup.findUnique({ where: { id } });
    if (!row) {
      res.status(404).json({ success: false, error: 'Church not found' });
      return;
    }

    const raw = (row.rawData && typeof row.rawData === 'object' && !Array.isArray(row.rawData)
      ? row.rawData
      : {}) as Record<string, any>;
    raw.status = 'rejected';
    raw.rejectReason = reason || 'Request rejected by admin';

    await prisma.subgroup.update({
      where: { id },
      data: {
        status: 'rejected',
        rawData: raw,
      },
    });

    const targetUser = raw.coordinatorId || raw.createdBy;
    if (targetUser) {
      const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await prisma.broadcastNotification.create({
        data: {
          id: notifId,
          title: 'Church Request Update',
          body: `Your request for "${row.name || raw.name}" was not approved: ${reason || 'Declined by admin'}`,
          message: `Your request for "${row.name || raw.name}" was not approved: ${reason || 'Declined by admin'}`,
          type: 'church_rejected',
          organizationId: row.organizationId,
          createdAt: new Date(),
          rawData: { subgroupId: id, status: 'rejected', reason, targetUserId: targetUser },
        },
      }).catch(err => console.error('[subgroups/reject] notif error:', err));
    }

    res.json({ success: true, message: 'Church request rejected' });
  } catch (err: any) {
    console.error('[subgroups/:id/reject]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to reject church' });
  }
});

/** PATCH /subgroups/:id — update name, description, or status */
router.patch('/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const { id } = req.params;
    const row = await prisma.subgroup.findUnique({ where: { id } });
    if (!row) { res.status(404).json({ success: false, error: 'Not found' }); return; }

    const raw = (row.rawData && typeof row.rawData === 'object' && !Array.isArray(row.rawData)
      ? row.rawData : {}) as Record<string, any>;

    const isCoordinator = raw.coordinatorId === auth.userId || raw.coordinator_id === auth.userId;
    const isAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'zone_admin';
    if (!isCoordinator && !isAdmin) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }

    const { name, description, status } = req.body || {};
    const updateFields: Record<string, any> = { updatedAt: new Date() };
    if (name !== undefined) { updateFields.name = name.trim(); raw.name = name.trim(); }
    if (description !== undefined) { updateFields.description = description.trim(); raw.description = description.trim(); }
    if (status !== undefined && isAdmin) { updateFields.status = status; raw.status = status; }
    updateFields.rawData = raw;

    const updated = await prisma.subgroup.update({
      where: { id },
      data: updateFields,
    });
    res.json({ success: true, data: shapeSubgroup(updated as any) });
  } catch (err: any) {
    console.error('[subgroups/:id PATCH]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update' });
  }
});

/** DELETE /subgroups/:id — coordinator or admin only */
router.delete('/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const { id } = req.params;
    const row = await prisma.subgroup.findUnique({ where: { id } });
    if (!row) { res.status(404).json({ success: false, error: 'Not found' }); return; }

    const raw = (row.rawData && typeof row.rawData === 'object' ? row.rawData : {}) as Record<string, any>;
    const isCoordinator = raw.coordinatorId === auth.userId;
    const isAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    if (!isCoordinator && !isAdmin) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }

    await prisma.subgroup.delete({ where: { id } });
    res.json({ success: true, message: 'Subgroup deleted' });
  } catch (err: any) {
    console.error('[subgroups/:id DELETE]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete' });
  }
});

/** GET /subgroups/:id/members — list members with profile data */
router.get('/:id/members', requireAuth, async (req, res) => {
  try {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid id' }); return; }

    const subgroup = await prisma.subgroup.findUnique({ where: { id: parsed.data } });
    if (!subgroup) { res.status(404).json({ success: false, error: 'Subgroup not found' }); return; }
    if (!canAccessSubgroup(req, subgroup)) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }

    const raw = (subgroup.rawData && typeof subgroup.rawData === 'object' ? subgroup.rawData : {}) as Record<string, any>;
    const userIds: string[] = Array.isArray(raw.memberIds) ? raw.memberIds : Array.isArray(raw.member_ids) ? raw.member_ids : [];

    const memberships = await prisma.membership.findMany({
      where: {
        OR: [
          { subgroupId: parsed.data },
          { userId: { in: userIds } },
        ],
      },
      include: { user: true },
    });

    const data = memberships.map(m => ({
      userId: m.userId,
      role: m.role,
      status: m.status,
      profile: m.user,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[subgroups/:id/members GET]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** POST /subgroups/members — add a member to a subgroup + send notification */
router.post('/members', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const schema = z.object({
      subGroupId: z.string().min(1),
      userId: z.string().min(1),
      role: z.enum(['member', 'coordinator', 'admin']).default('member'),
      addedBy: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, error: 'Invalid body' }); return; }

    const { subGroupId, userId, role, addedBy } = parsed.data;

    const sg = await prisma.subgroup.findUnique({ where: { id: subGroupId } });
    if (!sg) { res.status(404).json({ success: false, error: 'Subgroup not found' }); return; }

    const raw = (sg.rawData && typeof sg.rawData === 'object' ? sg.rawData : {}) as Record<string, any>;
    const isCoordinator = raw.coordinatorId === auth.userId || raw.coordinator_id === auth.userId;
    const isAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'zone_admin';
    if (!isCoordinator && !isAdmin) { res.status(403).json({ success: false, error: 'Only coordinators can add members' }); return; }

    await prisma.membership.upsert({
      where: { userId_organizationId: { userId, organizationId: sg.organizationId } },
      create: { userId, organizationId: sg.organizationId, subgroupId: subGroupId, role: 'MEMBER' },
      update: { subgroupId: subGroupId },
    });

    const memberIds: string[] = Array.isArray(raw.memberIds) ? raw.memberIds : [];
    if (!memberIds.includes(userId)) {
      raw.memberIds = [...memberIds, userId];
      await prisma.subgroup.update({ where: { id: subGroupId }, data: { rawData: raw } });
    }

    const coordinatorUser = await prisma.user.findUnique({ where: { id: auth.userId } });
    const coordinatorName = coordinatorUser
      ? [coordinatorUser.firstName, coordinatorUser.lastName].filter(Boolean).join(' ') || 'Your coordinator'
      : 'Your coordinator';

    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await prisma.broadcastNotification.create({
      data: {
        id: notifId,
        title: 'Added to Subgroup 🎵',
        body: `${coordinatorName} added you to "${sg.name || raw.name || 'a subgroup'}". You now have access to its rehearsal songs and setlists.`,
        message: `${coordinatorName} added you to "${sg.name || raw.name || 'a subgroup'}". You now have access to its rehearsal songs and setlists.`,
        type: 'subgroup_added',
        organizationId: sg.organizationId,
        createdAt: new Date(),
        rawData: { subgroupId: subGroupId, subgroupName: sg.name || raw.name, addedBy: auth.userId, targetUserId: userId },
      },
    }).catch(err => console.error('[subgroups/members] notif error:', err));

    res.status(201).json({ success: true, message: 'Member added successfully', data: { userId, subGroupId, role, status: 'active' } });
  } catch (err: any) {
    console.error('[subgroups/members POST]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to add member' });
  }
});

/** DELETE /subgroups/members?subGroupId=&userId= — remove a member */
router.delete('/members', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const { subGroupId, userId } = req.query as { subGroupId?: string; userId?: string };
    if (!subGroupId || !userId) { res.status(400).json({ success: false, error: 'subGroupId and userId are required' }); return; }

    const sg = await prisma.subgroup.findUnique({ where: { id: subGroupId } });
    if (!sg) { res.status(404).json({ success: false, error: 'Subgroup not found' }); return; }

    const raw = (sg.rawData && typeof sg.rawData === 'object' ? sg.rawData : {}) as Record<string, any>;
    const isCoordinator = raw.coordinatorId === auth.userId || raw.coordinator_id === auth.userId;
    const isAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'zone_admin';
    const isSelf = auth.userId === userId;
    if (!isCoordinator && !isAdmin && !isSelf) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }

    await prisma.membership.updateMany({
      where: { userId, subgroupId: subGroupId },
      data: { subgroupId: null },
    });

    const memberIds: string[] = Array.isArray(raw.memberIds) ? raw.memberIds : [];
    raw.memberIds = memberIds.filter((id: string) => id !== userId);
    await prisma.subgroup.update({ where: { id: subGroupId }, data: { rawData: raw } });

    res.json({ success: true, message: 'Member removed' });
  } catch (err: any) {
    console.error('[subgroups/members DELETE]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to remove member' });
  }
});

/** POST /subgroups/praise-nights — create a new rehearsal setlist */
router.post('/praise-nights', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { name, date, location, category = 'ongoing', subGroupId } = req.body || {};
    if (!subGroupId || !name?.trim()) {
      res.status(400).json({ success: false, error: 'subGroupId and name are required' });
      return;
    }
    const id = `sgpn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const row = await prisma.program.create({
      data: {
        id,
        name: name.trim(),
        date: date || '',
        location: location || '',
        category,
        subgroupId: subGroupId,
        songIds: [],
        rawData: { subGroupId, subgroupId: subGroupId, name, date, location, category },
      },
    });
    res.status(201).json({ success: true, data: mergeRawRow(row) });
  } catch (err: any) {
    console.error('[subgroups/praise-nights POST]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to create setlist' });
  }
});

/** PATCH /subgroups/praise-nights/:id — update a setlist */
router.patch('/praise-nights/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const row = await prisma.program.findUnique({ where: { id } });
    if (!row) { res.status(404).json({ success: false, error: 'Setlist not found' }); return; }

    const { name, date, location, category, songIds } = req.body || {};
    const prevRaw = (row.rawData && typeof row.rawData === 'object' ? row.rawData : {}) as Record<string, any>;
    const nextRaw = {
      ...prevRaw,
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(songIds !== undefined ? { songIds } : {}),
    };

    const updated = await prisma.program.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(date !== undefined ? { date } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(songIds !== undefined ? { songIds } : {}),
        rawData: nextRaw,
      },
    });

    res.json({ success: true, data: mergeRawRow(updated as any) });
  } catch (err: any) {
    console.error('[subgroups/praise-nights/:id PATCH]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update setlist' });
  }
});

/** DELETE /subgroups/praise-nights/:id */
router.delete('/praise-nights/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.program.delete({ where: { id } });
    res.json({ success: true, message: 'Setlist deleted' });
  } catch (err: any) {
    console.error('[subgroups/praise-nights/:id DELETE]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete setlist' });
  }
});

/** POST /subgroups/songs/import — import song(s) from All Ministered / Master catalog into subgroup */
router.post('/songs/import', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const { masterSongIds, masterSongId, subGroupId, zoneId, praiseNightId } = req.body || {};
    const ids: string[] = Array.isArray(masterSongIds)
      ? masterSongIds
      : masterSongId ? [masterSongId] : [];

    if (!subGroupId || ids.length === 0) {
      res.status(400).json({ success: false, error: 'subGroupId and masterSongIds are required' });
      return;
    }

    const masterRows = await prisma.song.findMany({
      where: { id: { in: ids } },
    });

    if (masterRows.length === 0) {
      res.status(404).json({ success: false, error: 'Master song(s) not found' });
      return;
    }

    const importedSongs: any[] = [];
    const insertedIds: string[] = [];

    for (const mRow of masterRows) {
      const mData = mergeRawRow(mRow);
      const songId = `sgs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const rawData = {
        ...mData,
        id: songId,
        subGroupId,
        sub_group_id: subGroupId,
        subgroupId: subGroupId,
        masterSongId: mRow.id,
        importedFromMaster: true,
        status: 'unheard',
        rehearsalStatus: 'unheard',
        history: [],
        comments: '',
        importedAt: new Date().toISOString(),
        importedBy: auth.userId,
      };

      const row = await prisma.song.create({
        data: {
          id: songId,
          title: String((mData as any).title || 'Untitled Song').trim(),
          key: String((mData as any).key || ''),
          tempo: String((mData as any).tempo || ''),
          organizationId: zoneId || (mData as any).zoneId || 'zone-001',
          subgroupId: subGroupId,
          status: 'ACTIVE',
          rawData,
        },
      });

      importedSongs.push(mergeRawRow(row));
      insertedIds.push(songId);
    }

    if (praiseNightId && insertedIds.length > 0) {
      for (const sId of insertedIds) {
        await prisma.programSong.create({
          data: { programId: praiseNightId, songId: sId },
        }).catch(() => {});
      }
      const pn = await prisma.program.findUnique({ where: { id: praiseNightId } });
      if (pn) {
        const rawPn = (pn.rawData && typeof pn.rawData === 'object' ? pn.rawData : {}) as Record<string, any>;
        const currentSongIds = Array.isArray(pn.songIds) ? pn.songIds as string[] : Array.isArray(rawPn.songIds) ? rawPn.songIds as string[] : [];
        const nextSongIds = Array.from(new Set([...currentSongIds, ...insertedIds]));
        await prisma.program.update({
          where: { id: praiseNightId },
          data: {
            songIds: nextSongIds,
            rawData: { ...rawPn, songIds: nextSongIds },
          },
        });
      }
    }

    res.status(201).json({ success: true, count: importedSongs.length, data: importedSongs });
  } catch (err: any) {
    console.error('[subgroups/songs/import POST]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to import songs' });
  }
});

/** POST /subgroups/songs — add a song to a subgroup with full rich metadata */
router.post('/songs', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const {
      title, key, tempo, writer, leadSinger, lyrics, solfa, notation, solfas,
      audioFile, audioUrls, category, categories, subGroupId, zoneId, comments, history, conductorGuide,
    } = req.body || {};
    if (!subGroupId || !title?.trim()) {
      res.status(400).json({ success: false, error: 'subGroupId and title are required' });
      return;
    }
    const id = `sgs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const rawData = {
      subGroupId,
      sub_group_id: subGroupId,
      subgroupId: subGroupId,
      id,
      title: title.trim(),
      key: key || '',
      tempo: tempo || '',
      writer: writer || '',
      leadSinger: leadSinger || '',
      lyrics: lyrics || '',
      solfa: solfa || notation || solfas || '',
      audioFile: audioFile || '',
      audioUrls: audioUrls || {},
      category: category || 'Praise Night',
      categories: categories || [category || 'Praise Night'],
      comments: comments || '',
      history: Array.isArray(history) ? history : [],
      conductorGuide: conductorGuide || '',
      status: 'unheard',
      rehearsalStatus: 'unheard',
      createdAt: new Date().toISOString(),
    };
    const row = await prisma.song.create({
      data: {
        id,
        title: title.trim(),
        key: key || '',
        tempo: tempo || '',
        organizationId: zoneId || 'zone-001',
        subgroupId: subGroupId,
        status: 'ACTIVE',
        rawData,
      },
    });
    res.status(201).json({ success: true, data: mergeRawRow(row) });
  } catch (err: any) {
    console.error('[subgroups/songs POST]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to add song' });
  }
});

/** PATCH /subgroups/songs/:id — update all subgroup song fields */
router.patch('/songs/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const row = await prisma.song.findUnique({ where: { id } });
    if (!row) { res.status(404).json({ success: false, error: 'Song not found' }); return; }

    const {
      title, key, tempo, writer, leadSinger, lyrics, solfa, notation, solfas,
      audioFile, audioUrls, category, categories, status, rehearsalStatus, isActive,
      comments, history, conductorGuide, customParts,
    } = req.body || {};

    const prevRaw = (row.rawData && typeof row.rawData === 'object' ? row.rawData : {}) as Record<string, any>;
    const nextRaw = {
      ...prevRaw,
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(tempo !== undefined ? { tempo } : {}),
      ...(writer !== undefined ? { writer } : {}),
      ...(leadSinger !== undefined ? { leadSinger } : {}),
      ...(lyrics !== undefined ? { lyrics } : {}),
      ...(solfa !== undefined ? { solfa } : {}),
      ...(notation !== undefined ? { solfa: notation } : {}),
      ...(solfas !== undefined ? { solfas } : {}),
      ...(audioFile !== undefined ? { audioFile } : {}),
      ...(audioUrls !== undefined ? { audioUrls } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(categories !== undefined ? { categories } : {}),
      ...(status !== undefined ? { status, rehearsalStatus: status } : {}),
      ...(rehearsalStatus !== undefined ? { status: rehearsalStatus, rehearsalStatus } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(comments !== undefined ? { comments } : {}),
      ...(history !== undefined ? { history } : {}),
      ...(conductorGuide !== undefined ? { conductorGuide } : {}),
      ...(customParts !== undefined ? { customParts } : {}),
      updatedAt: new Date().toISOString(),
    };

    const updated = await prisma.song.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(tempo !== undefined ? { tempo } : {}),
        ...(status !== undefined ? { status } : {}),
        rawData: nextRaw,
      },
    });

    res.json({ success: true, data: mergeRawRow(updated as any) });
  } catch (err: any) {
    console.error('[subgroups/songs/:id PATCH]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update song' });
  }
});

/** DELETE /subgroups/songs/:id — delete a subgroup song */
router.delete('/songs/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.song.delete({ where: { id } });
    res.json({ success: true, message: 'Song deleted' });
  } catch (err: any) {
    console.error('[subgroups/songs/:id DELETE]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete song' });
  }
});

export default router;
