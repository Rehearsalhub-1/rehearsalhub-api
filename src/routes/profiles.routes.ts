import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { hashPassword } from '../auth/password';
import { broadcast } from '../ws/wsServer';

const router = Router();

function asRaw(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function directoryDto(row: any) {
  const raw = asRaw(row.rawData);
  const avatar = row.avatarUrl ?? (typeof raw.avatar === 'string' ? raw.avatar : (typeof raw.profile_image_url === 'string' ? raw.profile_image_url : null));
  const phone = typeof raw.phone === 'string' ? raw.phone : (typeof raw.phone_number === 'string' ? raw.phone_number : (typeof raw.phoneNumber === 'string' ? raw.phoneNumber : null));
  const zoneCode = typeof raw.zone_code === 'string' ? raw.zone_code : (typeof raw.zoneCode === 'string' ? raw.zoneCode : null);

  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    first_name: row.firstName,
    last_name: row.lastName,
    middle_name: typeof raw.middle_name === 'string' ? raw.middle_name : (typeof raw.middleName === 'string' ? raw.middleName : null),
    email: row.email,
    username: typeof raw.username === 'string' ? raw.username : null,
    alias: typeof raw.alias === 'string' ? raw.alias : null,
    phone,
    phoneNumber: phone,
    phone_number: phone,
    avatar,
    avatarUrl: avatar,
    profile_image_url: avatar,
    designation: typeof raw.designation === 'string' ? raw.designation : null,
    administration: typeof raw.administration === 'string' ? raw.administration : null,
    zoneCode,
    zone_code: zoneCode,
    church: typeof raw.church === 'string' ? raw.church : null,
    region: typeof raw.region === 'string' ? raw.region : null,
    gender: typeof raw.gender === 'string' ? raw.gender : null,
    birthday: typeof raw.birthday === 'string' ? raw.birthday : null,
    role: row.role,
    hasHqAccess: row.hasHqAccess,
    has_hq_access: row.hasHqAccess,
    canAnnotate: !!raw.canAnnotate || !!raw.canUseAnnotation || !!raw.canUseBrush,
    can_annotate: !!raw.canAnnotate || !!raw.canUseAnnotation || !!raw.canUseBrush,
    canAccessArchive: !!raw.can_access_archive || !!raw.canAccessArchive || !!raw.canSeeArchive || !!row.hasHqAccess,
    can_access_archive: !!raw.can_access_archive || !!raw.canAccessArchive || !!raw.canSeeArchive || !!row.hasHqAccess,
    canAccessPreRehearsal: !!raw.can_access_pre_rehearsal || !!raw.canAccessPreRehearsal,
    can_access_pre_rehearsal: !!raw.can_access_pre_rehearsal || !!raw.canAccessPreRehearsal,
    hiddenFeatures: raw.hidden_features || raw.hiddenFeatures || {},
    hidden_features: raw.hidden_features || raw.hiddenFeatures || {},
    rawData: raw,
    raw_data: raw,
    createdAt: row.createdAt,
    created_at: row.createdAt,
    updatedAt: row.updatedAt,
    updated_at: row.updatedAt,
  };
}

const updateProfileSchema = z.object({
  first_name: z.string().optional(),
  firstName: z.string().optional(),
  last_name: z.string().optional(),
  lastName: z.string().optional(),
  middle_name: z.string().optional(),
  middleName: z.string().optional(),
  email: z.string().optional(),
  username: z.string().optional(),
  alias: z.string().optional(),
  password: z.string().min(1).optional(),
  role: z.string().optional(),
  has_hq_access: z.boolean().optional(),
  hasHqAccess: z.boolean().optional(),
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
  current_device_id: z.string().optional(),
  hidden_features: z.union([z.array(z.string()), z.record(z.boolean())]).optional(),
  hiddenFeatures: z.union([z.array(z.string()), z.record(z.boolean())]).optional(),
});

const directoryIdsQuerySchema = z
  .string()
  .optional()
  .transform((value) => {
    if (!value || value.trim().length === 0) {
      return [] as string[];
    }
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
  });

// GET /profiles/check-username/:username
router.get('/check-username/:username', requireAuth, async (req, res) => {
  const usernameParam = (req.params.username || '').trim().toLowerCase().replace(/^@/, '');
  if (!usernameParam) {
    res.json({ success: true, available: false, message: 'Username cannot be empty' });
    return;
  }

  const existingRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id FROM profiles
     WHERE lower(raw_data->>'username') = $1
        OR lower(raw_data->>'alias') = $1
     LIMIT 1`,
    usernameParam,
  );

  const existing = existingRows[0];
  const isAvailable = !existing || ((req as any).auth?.userId && existing.id === (req as any).auth.userId);
  res.json({ success: true, available: Boolean(isAvailable), username: usernameParam });
});

// GET /profiles?kingschat_id=xxx or GET /profiles?email=xxx or GET /profiles?username=xxx or GET /profiles?ids=a,b,c
router.get('/', requireAuth, async (req, res) => {
  const { kingschat_id, email, ids, username } = req.query;

  if (typeof username === 'string') {
    const clean = username.trim().toLowerCase().replace(/^@/, '');
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM profiles
       WHERE lower(raw_data->>'username') = $1
          OR lower(raw_data->>'alias') = $1`,
      clean,
    );
    res.json({ success: true, data: rows.map(directoryDto) });
    return;
  }

  if (typeof kingschat_id === 'string') {
    const rows = await prisma.profile.findMany({ where: { kingschatId: kingschat_id } });
    res.json({ success: true, data: rows });
    return;
  }

  if (typeof email === 'string') {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM profiles WHERE lower(email) = $1`,
      email.toLowerCase(),
    );
    res.json({ success: true, data: rows });
    return;
  }

  if (typeof ids === 'string' && ids.length > 0) {
    const idList = ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (idList.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    const rows = await prisma.profile.findMany({ where: { id: { in: idList } } });
    res.json({ success: true, data: rows });
    return;
  }

  res.status(400).json({ success: false, error: 'Provide kingschat_id, email, or ids query param' });
});

// GET /profiles/birthdays — Get users with birthdays today & upcoming
router.get('/birthdays', requireAuth, async (req, res) => {
  try {
    const { zoneId } = req.query;
    let rows: any[];
    if (zoneId && zoneId !== 'all' && zoneId !== 'global') {
      const cleanZone = String(zoneId).toLowerCase().trim().replace(/[\s-_]/g, '');
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM profiles
         WHERE (raw_data->>'birthday' IS NOT NULL AND raw_data->>'birthday' != '')
           AND (lower(replace(replace(COALESCE(raw_data->>'zone_code', ''), '-', ''), ' ', '')) = $1
             OR lower(replace(replace(COALESCE(raw_data->>'zoneCode', ''), '-', ''), ' ', '')) = $1
             OR lower(replace(replace(COALESCE(raw_data->>'zoneId', ''), '-', ''), ' ', '')) = $1
             OR lower(replace(replace(COALESCE(raw_data->>'zone_id', ''), '-', ''), ' ', '')) = $1)`,
        cleanZone,
      );
    } else {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM profiles WHERE raw_data->>'birthday' IS NOT NULL AND raw_data->>'birthday' != ''`
      );
    }

    const todayStr = new Date().toISOString().slice(5, 10); // MM-DD
    const result = rows.map((r) => {
      const raw = asRaw(r.rawData);
      const bday = typeof raw.birthday === 'string' ? raw.birthday : '';
      const bdayMMDD = bday ? bday.slice(5, 10) : '';
      return {
        id: r.id,
        first_name: r.firstName || (typeof raw.first_name === 'string' ? raw.first_name : 'Member'),
        last_name: r.lastName || (typeof raw.last_name === 'string' ? raw.last_name : ''),
        birthday: bday,
        profile_image_url: r.avatarUrl || (typeof raw.profile_image_url === 'string' ? raw.profile_image_url : ''),
        isToday: bdayMMDD === todayStr,
        zoneId: typeof raw.zone_code === 'string' ? raw.zone_code : (typeof raw.zoneCode === 'string' ? raw.zoneCode : ''),
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[profiles/birthdays]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch birthdays' });
  }
});

// GET /profiles/directory
router.get('/directory', requireAuth, async (req, res) => {
  const parsedIds = directoryIdsQuerySchema.safeParse(
    typeof req.query.ids === 'string' ? req.query.ids : undefined,
  );
  if (!parsedIds.success) {
    res.status(400).json({ success: false, error: 'Invalid ids query param' });
    return;
  }

  const auth = res.locals.auth;
  const idList = parsedIds.data;

  // If specific IDs are requested
  if (idList.length > 0) {
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin';
    const rows = await prisma.profile.findMany({ where: { id: { in: idList } } });
    if (!isHqAdmin) {
      const zoneId = req.tenant?.effectiveZoneId;
      const normalizedZone = String(zoneId || '').replace(/-/g, '').toLowerCase();
      const memberships = await prisma.$queryRawUnsafe<any[]>(
        `SELECT user_id FROM memberships
         WHERE (organization_id = $1 OR lower(replace(COALESCE(organization_id, ''), '-', '')) = $1)
           AND user_id = ANY($2::text[])`,
        normalizedZone,
        idList,
      ).catch(() => []);
      const allowedIds = new Set(memberships.map((m) => m.user_id));
      const scopedRows = rows.filter((row) => allowedIds.has(row.id) || row.id === auth.userId);
      res.json({ success: true, data: scopedRows.map(directoryDto) });
      return;
    }
    res.json({ success: true, data: rows.map(directoryDto) });
    return;
  }

  const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || !!auth.hasHqAccess;
  const requestedZoneCode = typeof req.query.zone_code === 'string' ? req.query.zone_code.trim() : (typeof req.query.zoneId === 'string' ? req.query.zoneId.trim() : null);
  const targetZone = (req as any).tenant?.effectiveZoneId !== undefined
    ? (req as any).tenant.effectiveZoneId
    : ((requestedZoneCode && requestedZoneCode !== 'all') ? requestedZoneCode : (!isHqAdmin ? (auth.zoneId as string | null) : null));

  if (targetZone) {
    const withoutHyphen = targetZone.replace(/-/g, '').toLowerCase();
    const withHyphen = targetZone.includes('-') ? targetZone.toLowerCase() : targetZone.toLowerCase().replace(/^zone(\d+)$/, 'zone-$1');

    const [directProfiles, memberRows] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM profiles
         WHERE lower(replace(COALESCE(raw_data->>'zone_code', ''), '-', '')) = $1
            OR lower(replace(COALESCE(raw_data->>'zoneCode', ''), '-', '')) = $1
            OR lower(replace(COALESCE(raw_data->>'zoneId', ''), '-', '')) = $1
            OR lower(replace(COALESCE(raw_data->>'zone_id', ''), '-', '')) = $1
            OR lower(COALESCE(raw_data->>'zone_code', '')) = $2
            OR lower(COALESCE(raw_data->>'zoneCode', '')) = $2
            OR lower(COALESCE(raw_data->>'zoneId', '')) = $2
            OR lower(COALESCE(raw_data->>'zone_id', '')) = $2`,
        withoutHyphen,
        withHyphen,
      ).catch(() => []),
      prisma.$queryRawUnsafe<any[]>(
        `SELECT user_id FROM memberships
         WHERE lower(replace(COALESCE(organization_id, ''), '-', '')) = $1
            OR lower(COALESCE(organization_id, '')) = $2`,
        withoutHyphen,
        withHyphen,
      ).catch(() => []),
    ]);

    const targetUserIds = new Set<string>([
      ...directProfiles.map(p => p.id),
      ...memberRows.map(m => m.user_id).filter(Boolean),
    ]);

    if (targetUserIds.size === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const uniqueIds = Array.from(targetUserIds);
    const allMatchingProfiles = await prisma.profile.findMany({ where: { id: { in: uniqueIds } } });
    res.json({ success: true, data: allMatchingProfiles.map(directoryDto) });
    return;
  }

  // A non-HQ caller must always receive only their signed tenant directory.
  const rows = await prisma.profile.findMany();
  const canViewAllProfiles = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin' || !!auth.hasHqAccess;
  if (canViewAllProfiles) {
    res.json({ success: true, data: rows.map(directoryDto) });
    return;
  }

  const normalizedZone = String(req.tenant?.effectiveZoneId || '').replace(/-/g, '').toLowerCase();
  const memberships = await prisma.$queryRawUnsafe<any[]>(
    `SELECT user_id FROM memberships
     WHERE lower(replace(COALESCE(organization_id, ''), '-', '')) = $1`,
    normalizedZone,
  ).catch(() => []);
  const allowedIds = new Set(memberships.map((m) => m.user_id));
  res.json({ success: true, data: rows.filter((row) => allowedIds.has(row.id) || row.id === auth.userId).map(directoryDto) });
});

// GET /profiles/:userId
router.get('/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const auth = res.locals.auth;
  const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin' || !!auth.hasHqAccess;
  const profile = await prisma.profile.findUnique({ where: { id: userId } });
  if (!profile) {
    res.status(404).json({ success: false, error: 'Profile not found' });
    return;
  }
  if (!isHqAdmin && auth.userId !== userId) {
    const zoneId = req.tenant?.effectiveZoneId;
    const normalizedZone = String(zoneId || '').replace(/-/g, '').toLowerCase();
    const membership = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM memberships
       WHERE (organization_id = $1 OR lower(replace(COALESCE(organization_id, ''), '-', '')) = $1) AND user_id = $2
       LIMIT 1`,
      normalizedZone,
      userId,
    ).catch(() => []);
    if (membership.length === 0) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
  }
  const canViewPrivate = auth.userId === userId || auth.role === 'hq_admin' || auth.role === 'admin';
  res.json({ success: true, data: canViewPrivate ? profile : directoryDto(profile) });
});

// PATCH /profiles/:userId
router.patch('/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const auth = res.locals.auth;

  const isOwner = auth.userId === userId;
  const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';

  if (!isOwner && !isHqAdmin) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }

  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid request body' });
    return;
  }

  const existing = await prisma.profile.findUnique({ where: { id: userId } });
  if (!existing) {
    res.status(404).json({ success: false, error: 'Profile not found' });
    return;
  }

  const body = parsed.data as Record<string, any>;
  const raw = asRaw(existing.rawData) as Record<string, any>;

  const firstName = body.first_name || body.firstName;
  const lastName = body.last_name || body.lastName;
  const middleName = body.middle_name || body.middleName;
  const phone = body.phone_number || body.phoneNumber;
  const zoneCode = body.zone_code || body.zoneCode || body.zone_id || body.zoneId;
  const kingschatId = body.kingschat_id || body.kingschatId;
  const avatar = body.profile_image_url || body.avatar_url || body.avatar;
  const hasHq = body.has_hq_access !== undefined ? body.has_hq_access : body.hasHqAccess;
  const hiddenFeatures = body.hidden_features !== undefined ? body.hidden_features : body.hiddenFeatures;

  if (firstName !== undefined) raw.first_name = firstName;
  if (lastName !== undefined) raw.last_name = lastName;
  if (middleName !== undefined) raw.middle_name = middleName;
  if (phone !== undefined) raw.phone_number = phone;
  if (body.gender !== undefined) raw.gender = body.gender;
  if (body.birthday !== undefined) raw.birthday = body.birthday;
  if (body.region !== undefined) raw.region = body.region;
  if (isHqAdmin && zoneCode !== undefined) {
    raw.zone_code = zoneCode;
    raw.zoneCode = zoneCode;
    raw.zoneId = zoneCode;
  }
  if (body.church !== undefined) raw.church = body.church;
  if (kingschatId !== undefined) raw.kingschat_id = kingschatId;
  if (body.designation !== undefined) raw.designation = body.designation;
  if (avatar !== undefined) {
    raw.profile_image_url = avatar;
    raw.avatar = avatar;
  }
  if (body.username !== undefined || body.alias !== undefined) {
    const candidate = String(body.username ?? body.alias ?? '').trim().toLowerCase().replace(/^@/, '');
    if (candidate) {
      const takenRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM profiles
         WHERE id != $1
           AND (lower(raw_data->>'username') = $2 OR lower(raw_data->>'alias') = $2)
         LIMIT 1`,
        userId,
        candidate,
      );

      if (takenRows.length > 0) {
        res.status(409).json({ success: false, error: `The username @${candidate} is already in use. Please choose another username.` });
        return;
      }
      raw.username = candidate;
      raw.alias = candidate;
    } else {
      delete raw.username;
      delete raw.alias;
    }
  }
  if (body.status !== undefined) raw.status = body.status;
  if (body.is_banned !== undefined) raw.is_banned = Boolean(body.is_banned);
  if (body.is_suspended !== undefined) raw.is_suspended = Boolean(body.is_suspended);
  if (body.is_active !== undefined) raw.is_active = Boolean(body.is_active);
  if (isHqAdmin && body.zone_code !== undefined) {
    raw.zone_code = body.zone_code;
    raw.zoneId = body.zone_code;
  }
  if (hiddenFeatures !== undefined) {
    raw.hidden_features = hiddenFeatures;
    raw.hiddenFeatures = hiddenFeatures;
  }
  if (body.can_access_archive !== undefined || body.canAccessArchive !== undefined) {
    const val = Boolean(body.can_access_archive ?? body.canAccessArchive);
    raw.can_access_archive = val;
    raw.canAccessArchive = val;
  }
  if (body.can_access_pre_rehearsal !== undefined || body.canAccessPreRehearsal !== undefined) {
    const val = Boolean(body.can_access_pre_rehearsal ?? body.canAccessPreRehearsal);
    raw.can_access_pre_rehearsal = val;
    raw.canAccessPreRehearsal = val;
  }
  if (body.canAnnotate !== undefined || body.can_annotate !== undefined || (body as any).canUseAnnotation !== undefined) {
    const val = Boolean(body.canAnnotate ?? body.can_annotate ?? (body as any).canUseAnnotation);
    raw.canAnnotate = val;
    raw.canUseAnnotation = val;
    raw.canUseBrush = val;
  }
  if (isHqAdmin && body.role !== undefined) {
    raw.role = body.role;
  }
  if (isHqAdmin && hasHq !== undefined) {
    raw.hasHqAccess = hasHq;
    raw.has_hq_access = hasHq;
  }

  // If password is provided, hash and update in auth_credentials
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
    ...(kingschatId !== undefined ? { kingschatId } : {}),
    ...(avatar !== undefined ? { avatarUrl: avatar } : {}),
    ...(body.email !== undefined ? { email: body.email.trim().toLowerCase() } : {}),
    rawData: raw,
    updatedAt: new Date().toISOString(),
  };

  const updated = await prisma.user.update({
    where: { id: userId },
    data: updateFields,
  });

  broadcast('profile', userId, updated);
  res.json({ success: true, message: 'Profile updated', data: updated });
});

// POST /profiles/:userId/password — Direct password update for user or HQ admin
router.post('/:userId/password', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isOwner = auth.userId === userId;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';

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

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err: any) {
    console.error('[profiles/:userId/password]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update password' });
  }
});

// PATCH /profiles/:userId/role — HQ Admin updates user role
router.patch('/:userId/role', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    if (!isHqAdmin) {
      res.status(403).json({ success: false, error: 'Only HQ Admins can update roles' });
      return;
    }

    const { userId } = req.params;
    const { role } = req.body;

    if (!role || !['member', 'zone_admin', 'hq_admin'].includes(role)) {
      res.status(400).json({ success: false, error: 'Invalid role specified' });
      return;
    }

    const hasHqAccess = role === 'hq_admin';
    const memberRole = role === 'hq_admin' ? 'HQ_ADMIN' : role === 'zone_admin' ? 'ZONE_ADMIN' : 'MEMBER';

    await prisma.membership.upsert({
      where: { userId_organizationId: { userId, organizationId: 'zone-001' } },
      create: { userId, organizationId: 'zone-001', role: memberRole as any, hasHqAccess },
      update: { role: memberRole as any, hasHqAccess },
    });

    res.json({ success: true, message: `Role updated to ${role}` });
  } catch (err: any) {
    console.error('[profiles/:userId/role]', err);
    res.status(500).json({ success: false, error: err?.message || 'Unable to update role' });
  }
});

// POST /profiles/:userId/approve — HQ admin approves a pending join request
router.post('/:userId/approve', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Only HQ admins can approve join requests' });
      return;
    }
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) { res.status(404).json({ success: false, error: 'Profile not found' }); return; }

    const raw = asRaw(existing.rawData);
    const updatedRaw = { ...raw, pending_hq_approval: false, is_active: true, status: 'active', approved_by: auth.userId, approved_at: new Date().toISOString() };
    await prisma.user.update({
      where: { id: userId },
      data: { rawData: updatedRaw, updatedAt: new Date().toISOString() },
    });

    await prisma.membership.upsert({
      where: { userId_organizationId: { userId, organizationId: 'zone-001' } },
      create: { userId, organizationId: 'zone-001', role: 'MEMBER', hasHqAccess: true },
      update: { hasHqAccess: true },
    });

    // Notify user their account is approved
    const notifId = crypto.randomUUID();
    await prisma.broadcastNotification.create({
      data: {
        id: notifId,
        type: 'join_request_approved',
        title: '🎉 Your HQ account has been approved',
        body: 'Your request to join the HQ group has been approved by an admin. You can now log in to the Rehearsal Hub Portal.',
        message: 'Your request to join the HQ group has been approved by an admin. You can now log in to the Rehearsal Hub Portal.',
        category: 'join_request',
        priority: 'HIGH',
        organizationId: 'zone-001',
        senderId: auth.userId,
        createdAt: new Date(),
        rawData: { type: 'join_request_approved', approvedBy: auth.userId, approvedAt: new Date().toISOString(), status: 'approved', zoneCode: raw.zone_code || null, targetUserId: userId } as any,
      },
    }).catch(() => {});

    // Dispatch email notification via Nodemailer
    const targetEmail = typeof existing.email === 'string' ? existing.email : (typeof raw.email === 'string' ? raw.email : '');
    if (targetEmail) {
      const singerName = [existing.firstName, existing.lastName].filter(Boolean).join(' ') || (typeof raw.first_name === 'string' ? raw.first_name : 'Singer');
      const zoneName = typeof raw.zone_code === 'string' ? raw.zone_code : undefined;
      const { sendAccountApprovalEmail } = await import('../services/email.service');
      sendAccountApprovalEmail(targetEmail, singerName, zoneName).catch(() => {});
    }

    res.json({ success: true, message: 'Account approved successfully' });
  } catch (err: any) {
    console.error('[profiles/:userId/approve]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to approve account' });
  }
});

// POST /profiles/:userId/reject — HQ admin rejects a pending join request
router.post('/:userId/reject', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Only HQ admins can reject join requests' });
      return;
    }
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) { res.status(404).json({ success: false, error: 'Profile not found' }); return; }

    const { reason } = req.body;
    const raw = asRaw(existing.rawData);
    const updatedRaw = { ...raw, pending_hq_approval: false, is_active: false, rejected: true, rejected_by: auth.userId, rejected_at: new Date().toISOString(), rejection_reason: reason || null };
    await prisma.user.update({
      where: { id: userId },
      data: { rawData: updatedRaw, updatedAt: new Date().toISOString() },
    });

    const notifId = crypto.randomUUID();
    await prisma.broadcastNotification.create({
      data: {
        id: notifId,
        type: 'join_request_rejected',
        title: 'HQ Join Request — Not Approved',
        body: reason
          ? `Your HQ join request was not approved. Reason: ${reason}`
          : 'Your request to join the HQ group was not approved at this time. Please contact your zone admin.',
        message: reason
          ? `Your HQ join request was not approved. Reason: ${reason}`
          : 'Your request to join the HQ group was not approved at this time. Please contact your zone admin.',
        category: 'join_request',
        priority: 'NORMAL',
        organizationId: 'zone-001',
        senderId: auth.userId,
        createdAt: new Date(),
        rawData: { type: 'join_request_rejected', rejectedBy: auth.userId, rejectedAt: new Date().toISOString(), reason: reason || null, status: 'rejected', targetUserId: userId },
      },
    }).catch(() => {});

    res.json({ success: true, message: 'Join request rejected' });
  } catch (err: any) {
    console.error('[profiles/:userId/reject]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to reject request' });
  }
});

// POST /profiles/:userId/suspend
router.post('/:userId/suspend', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden' }); return;
    }
    const existing = await prisma.profile.findUnique({ where: { id: userId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Profile not found' });

    const raw = asRaw(existing.rawData);
    const updatedRaw = { ...raw, status: 'suspended', is_suspended: true, is_active: false, suspended_by: auth.userId, suspended_at: new Date().toISOString() };
    await prisma.profile.update({
      where: { id: userId },
      data: { rawData: updatedRaw, updatedAt: new Date().toISOString() },
    });

    res.json({ success: true, message: 'Member account suspended' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to suspend member' });
  }
});

// POST /profiles/:userId/ban
router.post('/:userId/ban', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden' }); return;
    }
    const existing = await prisma.profile.findUnique({ where: { id: userId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Profile not found' });

    const raw = asRaw(existing.rawData);
    const updatedRaw = { ...raw, status: 'banned', is_banned: true, is_active: false, banned_by: auth.userId, banned_at: new Date().toISOString() };
    await prisma.profile.update({
      where: { id: userId },
      data: { rawData: updatedRaw, updatedAt: new Date().toISOString() },
    });

    res.json({ success: true, message: 'Member banned from platform' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to ban member' });
  }
});

// POST /profiles/:userId/reactivate
router.post('/:userId/reactivate', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Forbidden' }); return;
    }
    const existing = await prisma.profile.findUnique({ where: { id: userId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Profile not found' });

    const raw = asRaw(existing.rawData);
    const updatedRaw = { ...raw, status: 'active', is_banned: false, is_suspended: false, is_active: true, reactivated_by: auth.userId, reactivated_at: new Date().toISOString() };
    await prisma.profile.update({
      where: { id: userId },
      data: { rawData: updatedRaw, updatedAt: new Date().toISOString() },
    });

    res.json({ success: true, message: 'Member account reactivated' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to reactivate member' });
  }
});

// POST /profiles/:userId/remove-from-zone
router.post('/:userId/remove-from-zone', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    const isZoneAdmin = auth.role === 'zone_admin';
    if (!isHqAdmin && !isZoneAdmin) {
      res.status(403).json({ success: false, error: 'Forbidden' }); return;
    }
    const existing = await prisma.profile.findUnique({ where: { id: userId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Profile not found' });

    const raw = asRaw(existing.rawData);
    const updatedRaw = { ...raw, zone_code: null, zoneId: null, zoneName: 'Unassigned', removed_from_zone_at: new Date().toISOString() };
    await prisma.profile.update({
      where: { id: userId },
      data: { rawData: updatedRaw, updatedAt: new Date().toISOString() },
    });

    res.json({ success: true, message: 'Member removed from zone' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to remove member from zone' });
  }
});

export default router;
