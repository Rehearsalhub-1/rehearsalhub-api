import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

type MembershipRow = {
  id: string;
  userId: string;
  role: string | null;
  status: string | null;
  userEmail?: string | null;
  userName?: string | null;
  zoneId?: string | null;
  hqGroupId?: string | null;
};

async function enrichMemberships<T extends MembershipRow>(rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, profile: null }));

  const profileRows = await prisma.profile.findMany({ where: { id: { in: ids } } });
  const byId = new Map<string, any>(profileRows.map((p: any) => [p.id, p]));
  return rows.map((r) => {
    const p = byId.get(r.userId);
    return { ...r, profile: p ? { id: p.id, email: p.email, firstName: p.firstName, lastName: p.lastName, avatarUrl: p.avatarUrl, role: p.role } : null };
  });
}

function wantsEnrich(enrich: unknown): boolean {
  return enrich === '1' || enrich === 'true';
}

// GET /members/mine
router.get('/mine', requireAuth, async (req, res) => {
  const userId = res.locals.auth.userId as string;
  const profile = await prisma.profile.findUnique({ where: { id: userId } });
  if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

  const raw = (profile.rawData as any) || {};
  const zoneId = profile.zoneId || raw.zoneId || raw.zone_id || raw.zoneCode || null;

  const zoneMembers = zoneId ? [{ id: `zm_${userId}`, zoneId, userId, role: profile.role || 'member', status: profile.status || 'active', createdAt: profile.createdAt, rawData: null }] : [];
  const hqMembers = profile.hasHqAccess ? [{ id: `hqm_${userId}`, hqGroupId: 'hq', userId, userEmail: profile.email, userName: profile.name, role: profile.role || 'member', status: profile.status || 'active', rawData: null }] : [];

  res.json({ success: true, data: { zoneMembers, hqMembers } });
});

// GET /members/by-user/:userId
router.get('/by-user/:userId', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const { userId } = req.params;
  const isSelf = auth.userId === userId;
  const isAdmin = auth.role === 'admin' || auth.role === 'hq_admin';
  if (!isSelf && !isAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });

  const profile = await prisma.profile.findUnique({ where: { id: userId } });
  if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

  const raw = (profile.rawData as any) || {};
  const zoneId = profile.zoneId || raw.zoneId || raw.zone_id || raw.zoneCode || null;

  const zoneMembers = zoneId ? [{ id: `zm_${userId}`, zoneId, userId, role: profile.role || 'member', status: profile.status || 'active', createdAt: profile.createdAt, rawData: null }] : [];
  const hqMembers = profile.hasHqAccess ? [{ id: `hqm_${userId}`, hqGroupId: 'hq', userId, userEmail: profile.email, userName: profile.name, role: profile.role || 'member', status: profile.status || 'active', rawData: null }] : [];

  res.json({ success: true, data: { zoneMembers, hqMembers } });
});

// GET /members/hq
router.get('/hq', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  if (auth.role !== 'admin' && auth.role !== 'hq_admin') return res.status(403).json({ success: false, error: 'Forbidden' });
  const profiles = await prisma.profile.findMany({ where: { hasHqAccess: true } });
  const members = profiles.map((p) => ({
    id: `hqm_${p.id}`,
    hqGroupId: 'hq',
    userId: p.id,
    userEmail: p.email,
    userName: p.name,
    role: p.role || 'member',
    status: p.status || 'active',
    profile: p,
  }));
  res.json({ success: true, data: members });
});

// GET /members/hq/:hqGroupId
router.get('/hq/:hqGroupId', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const isHQAdmin = auth.role === 'admin' || auth.role === 'hq_admin' || auth.role === 'super_admin';
  if (!isHQAdmin && auth.zoneId !== req.params.hqGroupId) return res.status(403).json({ success: false, error: 'Forbidden' });
  const profiles = await prisma.profile.findMany({ where: { hasHqAccess: true } });
  const members = profiles.map((p) => ({
    id: `hqm_${p.id}`,
    hqGroupId: req.params.hqGroupId,
    userId: p.id,
    userEmail: p.email,
    userName: p.name,
    role: p.role || 'member',
    status: p.status || 'active',
    profile: p,
  }));
  res.json({ success: true, data: members });
});

// GET /members/zone/:zoneId
router.get('/zone/:zoneId', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const isHQAdmin = auth.role === 'admin' || auth.role === 'hq_admin' || auth.role === 'super_admin';
  const norm = (v: unknown) => String(v || '').replace(/-/g, '').toLowerCase();
  if (!isHQAdmin && norm(auth.zoneId) !== norm(req.params.zoneId)) return res.status(403).json({ success: false, error: 'Forbidden' });
  const profiles = await prisma.profile.findMany({ where: { zoneId: req.params.zoneId } });
  const members = profiles.map((p) => ({
    id: `zm_${p.id}`,
    zoneId: req.params.zoneId,
    userId: p.id,
    role: p.role || 'member',
    status: p.status || 'active',
    profile: p,
  }));
  res.json({ success: true, data: members });
});

// POST /members/zone-join
router.post('/zone-join', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { zone_id, is_hq } = req.body;
    if (!zone_id) return res.status(400).json({ success: false, error: 'Missing zone_id' });

    if (is_hq) {
      await prisma.profile.update({ where: { id: userId }, data: { hasHqAccess: true } });
    } else {
      await prisma.profile.update({ where: { id: userId }, data: { zoneId: zone_id } });
    }
    res.json({ success: true, message: 'Successfully joined' });
  } catch (err) {
    console.error('[members/zone-join]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /members/zone-leave
router.post('/zone-leave', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { zone_id, is_hq } = req.body;
    if (!zone_id) return res.status(400).json({ success: false, error: 'Missing zone_id' });

    if (is_hq) {
      await prisma.profile.update({ where: { id: userId }, data: { hasHqAccess: false } });
    } else {
      await prisma.profile.update({ where: { id: userId }, data: { zoneId: null } });
    }
    res.json({ success: true, message: 'Successfully left zone' });
  } catch (err) {
    console.error('[members/zone-leave]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /members/request-admin & /request-hq
const handleAccessRequest = async (req: any, res: any) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { zoneId, zoneCode, reason, userEmail, userName, requestedRole = 'zone_admin' } = req.body;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveRole = req.path.includes('hq') ? 'hq_member' : (requestedRole || 'zone_admin');

    await prisma.adminRequest.create({
      data: { id: requestId, userId, userEmail: userEmail || null, userName: userName || null, zoneId: zoneId || null, zoneCode: zoneCode || null, requestedRole: effectiveRole, status: 'pending', reason: reason || (effectiveRole === 'hq_member' ? 'Request to join HQ Group' : 'Request for Zonal Coordinator access'), rawData: req.body },
    });

    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    prisma.notification.create({
      data: { id: notifId, title: effectiveRole === 'hq_member' ? 'HQ Group Join Request' : 'New Coordinator Access Request', message: `${userName || userEmail || 'A user'} submitted a request for ${effectiveRole === 'hq_member' ? 'HQ Group Access' : 'Zonal Coordinator Access'}.`, type: 'admin_request', targetAudience: 'hq_admin', createdAt: new Date(), rawData: { requestId, userId, requestedRole: effectiveRole, link: '/admin?section=Members' } },
    }).catch((err) => console.error('[members/request] notif error:', err));

    res.json({ success: true, message: 'Request submitted for HQ review', data: { id: requestId } });
  } catch (err: any) {
    console.error('[members/request-admin]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to submit request' });
  }
};

router.post('/request-admin', requireAuth, handleAccessRequest);
router.post('/request-hq', requireAuth, handleAccessRequest);

// GET /members/admin-requests
router.get('/admin-requests', requireAuth, async (_req, res) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') return res.status(403).json({ success: false, error: 'Forbidden' });
    const rows = await prisma.adminRequest.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    console.error('[members/admin-requests]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch requests' });
  }
});

// POST /members/admin-requests/:id/approve
router.post('/admin-requests/:id/approve', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') return res.status(403).json({ success: false, error: 'Forbidden' });

    const reqRow = await prisma.adminRequest.findUnique({ where: { id: req.params.id } });
    if (!reqRow || !reqRow.userId) return res.status(404).json({ success: false, error: 'Request or user not found' });

    const roleToGrant = reqRow.requestedRole || 'zone_admin';
    if (roleToGrant === 'hq_member') {
      await prisma.profile.update({ where: { id: reqRow.userId }, data: { hasHqAccess: true } });
    } else {
      await prisma.profile.update({ where: { id: reqRow.userId }, data: { role: 'zone_admin' } });
    }

    await prisma.adminRequest.update({ where: { id: req.params.id }, data: { status: 'approved', reviewedBy: auth.userId, reviewedAt: new Date() } });

    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    prisma.notification.create({
      data: { id: notifId, title: 'Request Approved 🎉', message: roleToGrant === 'hq_member' ? 'Your request to join HQ Group has been approved!' : 'Your request for Coordinator access has been approved!', type: 'request_approved', targetUserId: reqRow.userId, createdAt: new Date(), rawData: { requestId: req.params.id, status: 'approved' } },
    }).catch((err) => console.error('[members/approve] notif error:', err));

    res.json({ success: true, message: `Request approved successfully (${roleToGrant})` });
  } catch (err: any) {
    console.error('[members/admin-requests/:id/approve]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to approve request' });
  }
});

// POST /members/admin-requests/:id/reject
router.post('/admin-requests/:id/reject', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') return res.status(403).json({ success: false, error: 'Forbidden' });

    const reqRow = await prisma.adminRequest.findUnique({ where: { id: req.params.id } });
    if (!reqRow) return res.status(404).json({ success: false, error: 'Request not found' });

    await prisma.adminRequest.update({ where: { id: req.params.id }, data: { status: 'rejected', reviewedBy: auth.userId, reviewedAt: new Date() } });

    const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    prisma.notification.create({
      data: { id: notifId, title: 'Request Status Update', message: 'Your access request was not approved by HQ admin at this time.', type: 'request_rejected', targetUserId: reqRow.userId, createdAt: new Date().toISOString(), rawData: { requestId: req.params.id, status: 'rejected' } },
    }).catch((err) => console.error('[members/reject] notif error:', err));

    res.json({ success: true, message: 'Request rejected' });
  } catch (err: any) {
    console.error('[members/admin-requests/:id/reject]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to reject request' });
  }
});

// PATCH /members/:userId
router.patch('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isOwner = auth.userId === userId;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    if (!isOwner && !isHqAdmin) return res.status(403).json({ success: false, error: 'Forbidden' });

    const existing = await prisma.profile.findUnique({ where: { id: userId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Member not found' });

    const body = req.body || {};
    const raw = (existing.rawData && typeof existing.rawData === 'object' && !Array.isArray(existing.rawData)
      ? existing.rawData : {}) as Record<string, any>;

    const firstName = body.first_name || body.firstName;
    const lastName = body.last_name || body.lastName;
    const phone = body.phone_number || body.phoneNumber;
    const zoneCode = body.zone_code || body.zoneCode || body.zone_id || body.zoneId;
    const kingschatId = body.kingschat_id || body.kingschatId;
    const avatar = body.profile_image_url || body.avatar_url || body.avatar;
    const hasHq = body.has_hq_access !== undefined ? body.has_hq_access : body.hasHqAccess;
    const hiddenFeatures = body.hidden_features !== undefined ? body.hidden_features : body.hiddenFeatures;

    if (firstName !== undefined) raw.first_name = firstName;
    if (lastName !== undefined) raw.last_name = lastName;
    if (phone !== undefined) raw.phone_number = phone;
    if (zoneCode !== undefined) { raw.zone_code = zoneCode; raw.zoneCode = zoneCode; raw.zoneId = zoneCode; }
    if (body.church !== undefined) raw.church = body.church;
    if (kingschatId !== undefined) raw.kingschat_id = kingschatId;
    if (body.designation !== undefined) raw.designation = body.designation;
    if (avatar !== undefined) { raw.profile_image_url = avatar; raw.avatar = avatar; }
    if (body.username !== undefined) raw.username = body.username.trim().toLowerCase();
    if (body.alias !== undefined) raw.alias = body.alias.trim().toLowerCase();
    if (hiddenFeatures !== undefined) { raw.hidden_features = hiddenFeatures; raw.hiddenFeatures = hiddenFeatures; }
    if (isHqAdmin && body.role !== undefined) raw.role = body.role;
    if (isHqAdmin && hasHq !== undefined) { raw.hasHqAccess = hasHq; raw.has_hq_access = hasHq; }

    // Handle password update
    if (body.password) {
      const { hashPassword } = await import('../auth/password');
      const hashedPassword = await hashPassword(body.password);
      const existingCred = await prisma.authCredential.findUnique({ where: { profileId: userId } });
      if (existingCred) {
        await prisma.authCredential.update({ where: { profileId: userId }, data: { passwordHash: hashedPassword, updatedAt: new Date() } });
      } else {
        await prisma.authCredential.create({ data: { profileId: userId, passwordHash: hashedPassword } });
      }
    }

    const updateData: Record<string, any> = {
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
      ...(kingschatId !== undefined ? { kingschatId } : {}),
      ...(avatar !== undefined ? { avatarUrl: avatar } : {}),
      ...(body.email !== undefined ? { email: body.email.trim().toLowerCase() } : {}),
      rawData: raw,
      updatedAt: new Date().toISOString(),
    };
    if (isHqAdmin && body.role !== undefined) updateData.role = body.role;
    if (isHqAdmin && hasHq !== undefined) updateData.hasHqAccess = hasHq;

    const updated = await prisma.profile.update({ where: { id: userId }, data: updateData });
    res.json({ success: true, message: 'Member updated successfully', data: updated });
  } catch (err: any) {
    console.error('[members/:userId PATCH]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update member' });
  }
});

export default router;
