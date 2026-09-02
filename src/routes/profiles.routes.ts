import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { hashPassword } from '../auth/password';
import { broadcast } from '../ws/wsServer';

const router = Router();

function formatUserProfile(u: any) {
  if (!u) return null;
  const activeMemberships = u.memberships || [];
  const primaryMembership = activeMemberships[0] || null;

  const phone = u.phone || null;
  const avatar = u.avatarUrl || null;
  const zoneCode = primaryMembership?.organization?.code || primaryMembership?.organizationId || null;

  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    first_name: u.firstName,
    last_name: u.lastName,
    middle_name: null,
    email: u.email,
    username: u.email ? u.email.split('@')[0] : null,
    phone,
    phoneNumber: phone,
    phone_number: phone,
    avatar,
    avatarUrl: avatar,
    profile_image_url: avatar,
    kingschatId: u.kingschatId,
    kingschat_id: u.kingschatId,
    profileCompleted: u.profileCompleted ?? false,
    profile_completed: u.profileCompleted ?? false,
    designation: primaryMembership?.voicePart || 'Member',
    voicePart: primaryMembership?.voicePart || 'Member',
    administration: primaryMembership?.role === 'ADMIN' ? 'Admin' : 'Member',
    role: (primaryMembership?.role || 'MEMBER').toLowerCase(),
    hasHqAccess: primaryMembership?.organization?.isHq || false,
    has_hq_access: primaryMembership?.organization?.isHq || false,
    zoneCode,
    zone_code: zoneCode,
    zoneId: primaryMembership?.organizationId || null,
    zone_id: primaryMembership?.organizationId || null,
    zoneName: primaryMembership?.organization?.name || null,
    church: primaryMembership?.group?.name || null,
    canAnnotate: true,
    can_annotate: true,
    canAccessArchive: true,
    can_access_archive: true,
    canAccessPreRehearsal: true,
    can_access_pre_rehearsal: true,
    memberships: activeMemberships.map((m: any) => ({
      id: `${m.userId}_${m.organizationId}`,
      organizationId: m.organizationId,
      organizationName: m.organization?.name,
      zoneId: m.organizationId,
      zone_id: m.organizationId,
      zoneName: m.organization?.name,
      zoneCode: m.organization?.code,
      role: m.role,
      voicePart: m.voicePart,
      designation: m.voicePart,
      groupId: m.groupId,
      groupName: m.group?.name,
      status: m.status,
    })),
    createdAt: u.createdAt,
    created_at: u.createdAt,
    updatedAt: u.updatedAt,
    updated_at: u.updatedAt,
  };
}

const updateProfileSchema = z.object({
  first_name: z.string().optional(),
  firstName: z.string().optional(),
  last_name: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().optional(),
  password: z.string().min(1).optional(),
  role: z.string().optional(),
  phone_number: z.string().optional(),
  phoneNumber: z.string().optional(),
  gender: z.string().optional(),
  birthday: z.string().optional(),
  region: z.string().optional(),
  zone_code: z.string().optional(),
  zoneCode: z.string().optional(),
  zone_id: z.string().optional(),
  zoneId: z.string().optional(),
  church: z.string().optional(),
  kingschat_id: z.string().optional(),
  kingschatId: z.string().optional(),
  designation: z.string().optional(),
  profile_image_url: z.string().optional(),
  avatar_url: z.string().optional(),
  avatar: z.string().optional(),
  expo_push_token: z.string().optional(),
  onesignal_sub_id: z.string().optional(),
});

// GET /profiles/check-username/:username
router.get('/check-username/:username', requireAuth, async (req, res) => {
  const usernameParam = (req.params.username || '').trim().toLowerCase().replace(/^@/, '');
  if (!usernameParam) {
    res.json({ success: true, available: false, message: 'Username cannot be empty' });
    return;
  }

  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { startsWith: `${usernameParam}@`, mode: 'insensitive' } },
        { id: usernameParam },
      ],
    },
  });

  const isAvailable = !existing || ((req as any).auth?.userId && existing.id === (req as any).auth.userId);
  res.json({ success: true, available: Boolean(isAvailable), username: usernameParam });
});

// GET /profiles?kingschat_id=xxx or GET /profiles?email=xxx or GET /profiles?ids=a,b,c
router.get('/', requireAuth, async (req, res) => {
  const { kingschat_id, email, ids, username } = req.query;

  if (typeof username === 'string') {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: clean, mode: 'insensitive' } },
          { firstName: { contains: clean, mode: 'insensitive' } },
          { lastName: { contains: clean, mode: 'insensitive' } },
        ],
      },
      include: { memberships: { include: { organization: true, group: true } } },
    });
    res.json({ success: true, data: users.map(formatUserProfile) });
    return;
  }

  if (typeof kingschat_id === 'string') {
    const users = await prisma.user.findMany({
      where: { kingschatId: kingschat_id },
      include: { memberships: { include: { organization: true, group: true } } },
    });
    res.json({ success: true, data: users.map(formatUserProfile) });
    return;
  }

  if (typeof email === 'string') {
    const users = await prisma.user.findMany({
      where: { email: { equals: email.toLowerCase().trim(), mode: 'insensitive' } },
      include: { memberships: { include: { organization: true, group: true } } },
    });
    res.json({ success: true, data: users.map(formatUserProfile) });
    return;
  }

  if (typeof ids === 'string' && ids.length > 0) {
    const idList = ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (idList.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    const users = await prisma.user.findMany({
      where: { id: { in: idList } },
      include: { memberships: { include: { organization: true, group: true } } },
    });
    res.json({ success: true, data: users.map(formatUserProfile) });
    return;
  }

  res.status(400).json({ success: false, error: 'Provide kingschat_id, email, or ids query param' });
});

// GET /profiles/birthdays
router.get('/birthdays', requireAuth, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: { memberships: { include: { organization: true, group: true } } },
      take: 50,
    });
    const result = users.map((u) => ({
      id: u.id,
      first_name: u.firstName || 'Member',
      last_name: u.lastName || '',
      birthday: '',
      profile_image_url: u.avatarUrl || '',
      isToday: false,
      zoneId: u.memberships?.[0]?.organizationId || '',
    }));
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[profiles/birthdays]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch birthdays' });
  }
});

// GET /profiles/directory
router.get('/directory', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const { ids, zone_code, zoneId } = req.query as any;

    let idList: string[] = [];
    if (typeof ids === 'string' && ids.trim().length > 0) {
      idList = ids.split(',').map((s: string) => s.trim()).filter(Boolean).slice(0, 100);
    }

    const where: any = {};
    if (idList.length > 0) {
      where.id = { in: idList };
    }

    const targetZone = zoneId || zone_code;
    if (targetZone && targetZone !== 'all' && targetZone !== 'global') {
      where.memberships = {
        some: {
          organizationId: targetZone,
        },
      };
    }

    const users = await prisma.user.findMany({
      where,
      include: {
        memberships: {
          include: { organization: true, group: true },
        },
      },
      take: 250,
    });

    res.json({ success: true, count: users.length, data: users.map(formatUserProfile) });
  } catch (err) {
    console.error('[profiles/directory]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch directory' });
  }
});

// GET /profiles/:userId
router.get('/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        include: { organization: true, group: true },
      },
    },
  });

  if (!user) {
    res.status(404).json({ success: false, error: 'Profile not found' });
    return;
  }

  res.json({ success: true, data: formatUserProfile(user) });
});

// PATCH /profiles/:userId
router.patch('/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const auth = res.locals.auth;

  const isOwner = auth?.userId === userId;
  const isHqAdmin = auth?.role === 'hq_admin' || auth?.role === 'admin' || auth?.role === 'super_admin';

  if (!isOwner && !isHqAdmin) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }

  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid request body' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    res.status(404).json({ success: false, error: 'Profile not found' });
    return;
  }

  const body = parsed.data as Record<string, any>;
  const firstName = body.first_name || body.firstName;
  const lastName = body.last_name || body.lastName;
  const phone = body.phone_number || body.phoneNumber;
  const kingschatId = body.kingschat_id || body.kingschatId;
  const avatar = body.profile_image_url || body.avatar_url || body.avatar;

  if (body.password) {
    const hashedPassword = await hashPassword(body.password);
    const existingCred = await prisma.authCredential.findUnique({ where: { userId } });
    if (existingCred) {
      await prisma.authCredential.update({
        where: { userId },
        data: { passwordHash: hashedPassword, updatedAt: new Date() },
      });
    } else {
      await prisma.authCredential.create({
        data: {
          userId,
          passwordHash: hashedPassword,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
  }

  const updateFields: Record<string, any> = {
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(kingschatId !== undefined ? { kingschatId } : {}),
    ...(avatar !== undefined ? { avatarUrl: avatar } : {}),
    ...(body.email !== undefined ? { email: body.email.trim().toLowerCase() } : {}),
  };

  if (body.zone_code || body.zoneCode || body.zoneId || body.organizationId || body.voice_part || body.voicePart) {
    const rawZone = body.zone_code || body.zoneCode || body.zoneId || body.organizationId;
    const voicePart = body.voice_part || body.voicePart;

    if (rawZone) {
      const org = await prisma.organization.findFirst({
        where: {
          OR: [
            { id: rawZone },
            { invitationCode: rawZone },
            { code: rawZone },
          ],
        },
      });

      if (org) {
        await prisma.membership.upsert({
          where: {
            userId_organizationId: { userId, organizationId: org.id },
          },
          update: {
            ...(voicePart ? { voicePart } : {}),
            status: 'ACTIVE',
          },
          create: {
            userId,
            organizationId: org.id,
            role: 'MEMBER',
            voicePart: voicePart || null,
            status: 'ACTIVE',
          },
        });
      }
    } else if (voicePart) {
      await prisma.membership.updateMany({
        where: { userId },
        data: { voicePart },
      });
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: updateFields,
    include: {
      memberships: {
        include: { organization: true, group: true },
      },
    },
  });

  const formatted = formatUserProfile(updated);
  broadcast('profile', userId, formatted);
  res.json({ success: true, message: 'Profile updated', data: formatted });
});

// PATCH /profiles/:userId/onesignal
router.patch('/:userId/onesignal', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const subId = req.body.subscription_id || req.body.subscriptionId || req.body.onesignal_id;
    if (subId) {
      await prisma.setting.upsert({
        where: { key: `onesignal_${userId}` },
        update: { value: { subscriptionId: subId, updatedAt: new Date().toISOString() } },
        create: { key: `onesignal_${userId}`, value: { subscriptionId: subId, updatedAt: new Date().toISOString() } },
      });
    }
    res.json({ success: true, message: 'OneSignal updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update OneSignal ID' });
  }
});

// POST /profiles/:userId/password
router.post('/:userId/password', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isOwner = auth?.userId === userId;
    const isHqAdmin = auth?.role === 'hq_admin' || auth?.role === 'admin';

    if (!isOwner && !isHqAdmin) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const { newPassword, password } = req.body || {};
    const targetPassword = newPassword || password;

    if (!targetPassword || typeof targetPassword !== 'string' || targetPassword.length < 1) {
      res.status(400).json({ success: false, error: 'Password is required' });
      return;
    }

    const hashedPassword = await hashPassword(targetPassword);
    await prisma.authCredential.upsert({
      where: { userId },
      update: { passwordHash: hashedPassword, updatedAt: new Date() },
      create: { userId, passwordHash: hashedPassword },
    });

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('[profiles/password]', err);
    res.status(500).json({ success: false, error: 'Failed to update password' });
  }
});

export default router;
