import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

// GET /organizations (or /zones) - List all organizations
router.get('/', async (_req, res) => {
  const rows = await prisma.organization.findMany({
    orderBy: { name: 'asc' },
    include: {
      groups: {
        select: { id: true, name: true, type: true, status: true },
      },
    },
  });
  res.json({ success: true, data: rows });
});

// POST /organizations (or /zones) - Create a new organization dynamically
router.post('/', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const role = String(auth?.role || '').toLowerCase();
  const isPlatformAdmin = role === 'super_admin' || role === 'boss' || role === 'admin' || role === 'hq_admin' || role === 'org_admin';
  if (!isPlatformAdmin) {
    return res.status(403).json({ success: false, error: 'Only Platform Administrators can create new organizations' });
  }

  const { name, code, country, region, isHq = false, invitationCode, adminUserId } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Organization name is required' });
  }

  const id = `org_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const cleanCode = (code || name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 10)).trim();
  const invCode = (invitationCode || cleanCode || `INV_${Date.now()}`).trim();

  try {
    const org = await prisma.organization.create({
      data: {
        id,
        name: name.trim(),
        code: cleanCode,
        country: country?.trim() || null,
        region: region?.trim() || null,
        isHq: Boolean(isHq),
        invitationCode: invCode,
      },
    });

    if (adminUserId && typeof adminUserId === 'string') {
      await prisma.membership.upsert({
        where: { userId_organizationId: { userId: adminUserId, organizationId: id } },
        create: {
          userId: adminUserId,
          organizationId: id,
          role: 'ORG_ADMIN',
          status: 'ACTIVE',
        },
        update: {
          role: 'ORG_ADMIN',
          status: 'ACTIVE',
        },
      });
    }

    res.status(201).json({ success: true, data: org });
  } catch (err: any) {
    console.error('[Organization Create Error]:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to create organization' });
  }
});

// GET /organizations/:organizationId (or /zones/:zoneId)
router.get('/:zoneId', async (req, res) => {
  const zone = await prisma.organization.findUnique({
    where: { id: req.params.zoneId },
    include: {
      groups: true,
    },
  });
  if (!zone) return res.status(404).json({ success: false, error: 'Organization not found' });
  res.json({ success: true, data: zone });
});

// PATCH /organizations/:organizationId (or /zones/:zoneId) - Update organization
router.patch('/:zoneId', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const role = String(auth?.role || '').toLowerCase();
  const isPlatformAdmin = role === 'super_admin' || role === 'boss' || role === 'admin' || role === 'hq_admin';
  const orgId = req.params.zoneId;

  // Check if caller is org admin of this organization
  const callerMembership = await prisma.membership.findFirst({
    where: { userId: auth?.id, organizationId: orgId },
  });
  const isOrgAdmin = callerMembership?.role === 'HQ_ADMIN' || callerMembership?.role === 'ZONE_ADMIN';

  if (!isPlatformAdmin && !isOrgAdmin) {
    return res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions to edit organization' });
  }

  const { name, code, country, region, invitationCode, isActive } = req.body || {};
  try {
    const updated = await prisma.organization.update({
      where: { id: orgId },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(code !== undefined && { code: code.trim() }),
        ...(country !== undefined && { country: country?.trim() || null }),
        ...(region !== undefined && { region: region?.trim() || null }),
        ...(invitationCode !== undefined && { invitationCode: invitationCode?.trim() || null }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
    });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to update organization' });
  }
});

// GET /organizations/:organizationId/members (or /zones/:zoneId/members)
router.get('/:zoneId/members', requireAuth, async (req, res) => {
  const auth = res.locals.auth;
  const role = String(auth?.role || '').toLowerCase();
  const isHqAdmin = role === 'hq_admin' || role === 'admin' || role === 'super_admin';
  const requestedZoneId = String(req.params.zoneId || '').trim().toLowerCase();
  const authZoneId = String(auth?.zoneId || '').trim().toLowerCase();
  const norm = (s: string) => s.replace(/-/g, '');
  if (!isHqAdmin && (!authZoneId || norm(requestedZoneId) !== norm(authZoneId))) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const memberships = await prisma.membership.findMany({
    where: { organizationId: req.params.zoneId },
    include: { user: true },
  });
  const members = memberships.map(m => ({ ...m.user, role: m.role, membership: m }));
  res.json({ success: true, data: members });
});

export default router;
