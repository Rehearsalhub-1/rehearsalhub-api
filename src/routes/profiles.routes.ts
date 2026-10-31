import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { canManageTenant, isHQRole } from '../auth/permissions';
import { isZonalOrHQAdminRole } from '../auth/auth.service';
import { hashPassword } from '../auth/password';
import { broadcast } from '../ws/wsServer';

const router = Router();

function formatUserProfile(u: any, metaInput?: any, requestedZone?: any) {
  const meta: Record<string, any> = (metaInput && typeof metaInput === 'object' && !Array.isArray(metaInput)) ? metaInput : {};
  const activeMemberships = (u.memberships || []).filter((m: any) => m.status === 'ACTIVE');

  // Only true HQ Admin roles count as HQ Admin (regular members in zone-001 are NOT HQ Admins)
  const hqMembership = activeMemberships.find((m: any) => isHQRole(m.role));
  const zoneAdminMembership = activeMemberships.find((m: any) =>
    isZonalOrHQAdminRole(m.role)
  );
  const primaryMembership = hqMembership || zoneAdminMembership || activeMemberships[0];

  const validRequestedZone = typeof requestedZone === 'string' && requestedZone !== 'all' && requestedZone !== 'global'
    ? requestedZone
    : '';
  const rawZoneLookup = validRequestedZone || meta.activeZoneId || meta.zone_code || meta.zoneCode || '';
  const preferredZoneKey = String(rawZoneLookup).trim().toLowerCase();
  const preferredZoneMembership = preferredZoneKey
    ? activeMemberships.find((m: any) =>
        String(m.organizationId || '').toLowerCase() === preferredZoneKey ||
        String(m.organization?.code || '').toLowerCase() === preferredZoneKey ||
        String(m.organization?.invitationCode || '').toLowerCase() === preferredZoneKey
      )
    : null;
  const activeZoneMembership = preferredZoneMembership || primaryMembership;

  const isUserHq =
    Boolean(hqMembership) ||
    isHQRole(meta.role) ||
    Boolean(meta.hasHqAccess) ||
    Boolean(meta.has_hq_access);

  const phone = u.phone || null;
  const avatar = u.avatarUrl || null;
  const zoneCode = activeZoneMembership?.organization?.code || activeZoneMembership?.organization?.invitationCode || activeZoneMembership?.organizationId || null;

  const username = meta.username || meta.alias || (u.email ? u.email.split('@')[0] : null);
  const middleName = meta.middle_name || meta.middleName || null;
  const gender = meta.gender || null;
  const birthday = meta.birthday || null;
  const region = meta.region || activeZoneMembership?.organization?.region || null;
  const church = meta.church || activeZoneMembership?.group?.name || primaryMembership?.group?.name || null;
  const designation = meta.designation || activeZoneMembership?.voicePart || primaryMembership?.voicePart || 'Member';
  const administration = isUserHq
    ? (meta.administration && meta.administration !== 'Member' ? meta.administration : 'HQ Admin')
    : (meta.administration || (activeZoneMembership?.role === 'ADMIN' || isZonalOrHQAdminRole(activeZoneMembership?.role) ? 'Admin' : 'Member'));

  const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Member';
  // For non-HQ users who belong to multiple zones, scope their role to the active/requested zone so privileges don't leak across zones
  const resolvedRole = isUserHq
    ? 'hq_admin'
    : preferredZoneMembership
      ? (preferredZoneMembership.role || 'MEMBER').toLowerCase()
      : (meta.role || primaryMembership?.role || 'MEMBER').toLowerCase();

  return {
    id: u.id,
    uid: u.id,
    userId: u.id,
    name: fullName,
    displayName: fullName,
    firstName: u.firstName,
    lastName: u.lastName,
    first_name: u.firstName,
    last_name: u.lastName,
    middle_name: middleName,
    middleName,
    email: u.email,
    username,
    alias: username,
    phone,
    phoneNumber: phone,
    phone_number: phone,
    avatar,
    avatarUrl: avatar,
    profile_image_url: avatar,
    gender,
    birthday,
    region,
    church,
    designation,
    voicePart: designation,
    voice_part: designation,
    administration,
    kingschatId: u.kingschatId,
    kingschat_id: u.kingschatId,
    profileCompleted: u.profileCompleted ?? false,
    profile_completed: u.profileCompleted ?? false,
    role: resolvedRole,
    hasHqAccess: isUserHq,
    has_hq_access: isUserHq,
    zoneCode,
    zone_code: zoneCode,
    zoneId: activeZoneMembership?.organizationId || null,
    zone_id: activeZoneMembership?.organizationId || null,
    zoneName: activeZoneMembership?.organization?.name || null,
    canAnnotate: isUserHq ? true : (meta.canAnnotate ?? (meta.hiddenFeatures ? !meta.hiddenFeatures.hideAnnotations : false)),
    can_annotate: isUserHq ? true : (meta.canAnnotate ?? (meta.hiddenFeatures ? !meta.hiddenFeatures.hideAnnotations : false)),
    canAccessArchive: isUserHq ? true : (meta.canSeeArchive ?? meta.canAccessArchive ?? meta.can_access_archive ?? false),
    can_access_archive: isUserHq ? true : (meta.canSeeArchive ?? meta.canAccessArchive ?? meta.can_access_archive ?? false),
    canSeeArchive: isUserHq ? true : (meta.canSeeArchive ?? meta.canAccessArchive ?? meta.can_access_archive ?? false),
    canAccessPreRehearsal: isUserHq ? true : (meta.can_access_pre_rehearsal ?? meta.canAccessPreRehearsal ?? false),
    can_access_pre_rehearsal: isUserHq ? true : (meta.can_access_pre_rehearsal ?? meta.canAccessPreRehearsal ?? false),
    canAccessOngoing: meta.can_access_ongoing ?? meta.canAccessOngoing ?? true,
    can_access_ongoing: meta.can_access_ongoing ?? meta.canAccessOngoing ?? true,
    hiddenFeatures: {
      hideArchives: isUserHq ? false : (meta.canSeeArchive !== undefined || meta.canAccessArchive !== undefined || meta.can_access_archive !== undefined
        ? !(meta.canSeeArchive ?? meta.canAccessArchive ?? meta.can_access_archive)
        : (meta.hiddenFeatures?.hideArchives ?? true)),
      hidePreRehearsal: isUserHq ? false : (meta.can_access_pre_rehearsal !== undefined || meta.canAccessPreRehearsal !== undefined
        ? !(meta.can_access_pre_rehearsal ?? meta.canAccessPreRehearsal)
        : (meta.hiddenFeatures?.hidePreRehearsal ?? true)),
      hideAnnotations: isUserHq ? false : (meta.canAnnotate !== undefined
        ? !meta.canAnnotate
        : (meta.hiddenFeatures?.hideAnnotations ?? true)),
      hideOngoing: meta.can_access_ongoing !== undefined || meta.canAccessOngoing !== undefined
        ? !(meta.can_access_ongoing ?? meta.canAccessOngoing)
        : (meta.hiddenFeatures?.hideOngoing ?? false),
      hideMinisteredSongs: false,
    },
    hidden_features: {
      hideArchives: isUserHq ? false : (meta.canSeeArchive !== undefined || meta.canAccessArchive !== undefined || meta.can_access_archive !== undefined
        ? !(meta.canSeeArchive ?? meta.canAccessArchive ?? meta.can_access_archive)
        : (meta.hiddenFeatures?.hideArchives ?? true)),
      hidePreRehearsal: isUserHq ? false : (meta.can_access_pre_rehearsal !== undefined || meta.canAccessPreRehearsal !== undefined
        ? !(meta.can_access_pre_rehearsal ?? meta.canAccessPreRehearsal)
        : (meta.hiddenFeatures?.hidePreRehearsal ?? true)),
      hideAnnotations: isUserHq ? false : (meta.canAnnotate !== undefined
        ? !meta.canAnnotate
        : (meta.hiddenFeatures?.hideAnnotations ?? true)),
      hideOngoing: meta.can_access_ongoing !== undefined || meta.canAccessOngoing !== undefined
        ? !(meta.can_access_ongoing ?? meta.canAccessOngoing)
        : (meta.hiddenFeatures?.hideOngoing ?? false),
      hideMinisteredSongs: false,
    },
    expoPushToken: meta.expoPushToken || meta.expo_push_token || null,
    expo_push_token: meta.expoPushToken || meta.expo_push_token || null,
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
  middle_name: z.string().optional(),
  middleName: z.string().optional(),
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
  organizationId: z.string().optional(),
  church: z.string().optional(),
  kingschat_id: z.string().optional(),
  kingschatId: z.string().optional(),
  designation: z.string().optional(),
  administration: z.string().optional(),
  voice_part: z.string().optional(),
  voicePart: z.string().optional(),
  username: z.string().optional(),
  alias: z.string().optional(),
  profile_image_url: z.string().optional(),
  avatar_url: z.string().optional(),
  avatar: z.string().optional(),
  expo_push_token: z.string().optional(),
  expoPushToken: z.string().optional(),
}).passthrough();

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

  // Default: Return directory list of profiles (supports ?limit, ?search, ?zoneId)
  try {
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '500', 10), 1), 1000);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const whereClause: any = {};
    if (search) {
      whereClause.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      include: {
        memberships: {
          include: { organization: true, group: true },
        },
      },
      take: limit,
      orderBy: { firstName: 'asc' },
    });

    res.json({ success: true, count: users.length, data: users.map(formatUserProfile) });
  } catch (err: any) {
    console.error('[profiles:get:all]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to load profiles' });
  }
});

// GET /profiles/birthdays
router.get('/birthdays', requireAuth, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: { memberships: { include: { organization: true, group: true } } },
      take: 200,
    });
    const metaKeys = users.map((u) => `profile_meta_${u.id}`);
    const metaSettings = await prisma.setting.findMany({
      where: { key: { in: metaKeys } },
    });
    const metaMap = new Map<string, any>();
    metaSettings.forEach((s) => {
      const uId = s.key.replace('profile_meta_', '');
      metaMap.set(uId, s.value);
    });

    const now = new Date();
    const result: any[] = [];
    for (const u of users) {
      const meta = metaMap.get(u.id) || {};
      const rawBday = meta.birthday || meta.dob || meta.dateOfBirth || (u as any).birthday;
      if (!rawBday) continue;
      const bDate = new Date(rawBday);
      if (isNaN(bDate.getTime())) continue;

      const isToday = bDate.getMonth() === now.getMonth() && bDate.getDate() === now.getDate();

      result.push({
        id: u.id,
        first_name: u.firstName || 'Member',
        last_name: u.lastName || '',
        birthday: rawBday,
        profile_image_url: u.avatarUrl || meta.avatar || '',
        isToday,
        zoneId: u.memberships?.[0]?.organizationId || '',
      });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[profiles/birthdays]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch birthdays' });
  }
});

// GET /profiles & GET /profiles/directory — List all directory profiles
const handleGetDirectory = async (req: any, res: any) => {
  try {
    const auth = res.locals.auth;
    const { ids, zone_code, zoneId, limit = 500 } = req.query as any;

    let idList: string[] = [];
    if (typeof ids === 'string' && ids.trim().length > 0) {
      idList = ids.split(',').map((s: string) => s.trim()).filter(Boolean).slice(0, 500);
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
      orderBy: [
        { firstName: 'asc' },
        { lastName: 'asc' },
      ],
      take: Math.min(parseInt(limit as string) || 500, 1000),
    });

    const metaMap = new Map<string, any>();
    try {
      const metaKeys = users.map(u => `profile_meta_${u.id}`);
      const metaSettings = await prisma.setting.findMany({
        where: { key: { in: metaKeys } },
      });
      metaSettings.forEach(s => {
        const uId = s.key.replace('profile_meta_', '');
        metaMap.set(uId, s.value);
      });
    } catch {
      // Non-blocking fallback if settings table is missing
    }

    res.json({ success: true, count: users.length, data: users.map(u => formatUserProfile(u, metaMap.get(u.id) || {}, targetZone)) });
  } catch (err) {
    console.error('[profiles/directory]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch directory' });
  }
};

router.get('/', requireAuth, handleGetDirectory);
router.get('/directory', requireAuth, handleGetDirectory);

// GET /profiles/:userId
router.get('/:userId', requireAuth, async (req, res) => {
  let { userId } = req.params;
  if (userId === 'me' || !userId) {
    userId = res.locals.auth.userId;
  }
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

  let meta: Record<string, any> = {};
  try {
    const metaRow = await prisma.setting.findUnique({ where: { key: `profile_meta_${userId}` } });
    if (metaRow?.value && typeof metaRow.value === 'object') {
      meta = metaRow.value as Record<string, any>;
    }
  } catch {
    // Non-blocking fallback if settings table is missing
  }
  res.json({ success: true, data: formatUserProfile(user, meta) });
});

// PATCH /profiles/:userId
router.patch('/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;
  const auth = res.locals.auth;

  const isOwner = auth?.userId === userId;
  const isHqAdmin = auth?.role === 'hq_admin' || auth?.role === 'admin' || auth?.role === 'super_admin';
  const isAdmin = isHqAdmin || canManageTenant(auth?.role);

  if (!isOwner && !isAdmin) {
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

  // Save profile metadata (username, middleName, gender, birthday, region, church, etc.)
  const metaKey = `profile_meta_${userId}`;
  let updatedMeta: Record<string, any> = {};
  try {
    const existingMeta = await prisma.setting.findUnique({ where: { key: metaKey } });
    const currentMeta = (existingMeta?.value as Record<string, any>) || {};
    const currentHidden = (currentMeta.hiddenFeatures || {});
    const incomingHidden = (body.hiddenFeatures || {});
    const mergedHidden = { ...currentHidden, ...incomingHidden };

    const effectiveCanAnnotate = body.canAnnotate !== undefined 
      ? body.canAnnotate 
      : (body.can_annotate !== undefined ? body.can_annotate : currentMeta.canAnnotate);
    if (effectiveCanAnnotate !== undefined) {
      mergedHidden.hideAnnotations = !effectiveCanAnnotate;
    }

    const effectiveCanPreRehearsal = body.can_access_pre_rehearsal !== undefined 
      ? body.can_access_pre_rehearsal 
      : (body.canAccessPreRehearsal !== undefined ? body.canAccessPreRehearsal : currentMeta.can_access_pre_rehearsal);
    if (effectiveCanPreRehearsal !== undefined) {
      mergedHidden.hidePreRehearsal = !effectiveCanPreRehearsal;
    }

    const effectiveCanArchive = body.canSeeArchive !== undefined
      ? body.canSeeArchive
      : (body.can_access_archive !== undefined ? body.can_access_archive : (body.canAccessArchive !== undefined ? body.canAccessArchive : currentMeta.canSeeArchive));
    if (effectiveCanArchive !== undefined) {
      mergedHidden.hideArchives = !effectiveCanArchive;
    }

    const effectiveCanOngoing = body.can_access_ongoing !== undefined 
      ? body.can_access_ongoing 
      : (body.canAccessOngoing !== undefined ? body.canAccessOngoing : currentMeta.can_access_ongoing);
    if (effectiveCanOngoing !== undefined) {
      mergedHidden.hideOngoing = !effectiveCanOngoing;
    }

    // Ensure HQ Admin status cannot be accidentally stripped via profile edits
    const userMemsForPatch = await prisma.membership.findMany({ where: { userId } }).catch(() => []);
    const isTargetHq =
      userMemsForPatch.some((m) => isHQRole(m.role)) ||
      isHQRole(currentMeta.role) ||
      Boolean(currentMeta.hasHqAccess) ||
      Boolean(currentMeta.has_hq_access);

    let effectiveRole = currentMeta.role;
    if (body.role !== undefined && isAdmin) {
      if (isTargetHq && ['church_admin', 'church_coordinator', 'group_admin', 'member'].includes(String(body.role).toLowerCase())) {
        effectiveRole = 'hq_admin';
      } else {
        effectiveRole = body.role;
      }
    } else if (isTargetHq) {
      effectiveRole = 'hq_admin';
    }

    let effectiveAdmin = body.administration !== undefined ? body.administration : currentMeta.administration;
    if (isTargetHq && (!effectiveAdmin || effectiveAdmin === 'Member')) {
      effectiveAdmin = currentMeta.administration && currentMeta.administration !== 'Member' ? currentMeta.administration : 'HQ Admin';
    }

    updatedMeta = {
      ...currentMeta,
      role: effectiveRole || (isTargetHq ? 'hq_admin' : currentMeta.role),
      ...(isTargetHq ? { hasHqAccess: true, has_hq_access: true } : {}),
      administration: effectiveAdmin,
      ...(body.username !== undefined ? { username: body.username } : {}),
      ...(body.alias !== undefined ? { alias: body.alias } : {}),
      ...(body.middle_name !== undefined ? { middle_name: body.middle_name } : {}),
      ...(body.middleName !== undefined ? { middle_name: body.middleName } : {}),
      ...(body.gender !== undefined ? { gender: body.gender } : {}),
      ...(body.birthday !== undefined ? { birthday: body.birthday } : {}),
      ...(body.region !== undefined ? { region: body.region } : {}),
      ...(body.church !== undefined ? { church: body.church } : {}),
      ...(body.designation !== undefined ? { designation: body.designation } : {}),
      ...(body.administration !== undefined ? { administration: body.administration } : {}),
      ...(body.canSeeArchive !== undefined ? { canSeeArchive: body.canSeeArchive } : {}),
      ...(body.can_access_archive !== undefined ? { can_access_archive: body.can_access_archive } : {}),
      ...(body.canAccessArchive !== undefined ? { canAccessArchive: body.canAccessArchive } : {}),
      ...(body.can_access_ongoing !== undefined ? { can_access_ongoing: body.can_access_ongoing } : {}),
      ...(body.can_access_pre_rehearsal !== undefined ? { can_access_pre_rehearsal: body.can_access_pre_rehearsal } : {}),
      ...(body.canAnnotate !== undefined ? { canAnnotate: body.canAnnotate } : {}),
      ...(body.can_annotate !== undefined ? { canAnnotate: body.can_annotate } : {}),
      hiddenFeatures: mergedHidden,
      ...((body.expoPushToken || body.expo_push_token) !== undefined ? {
        expoPushToken: body.expoPushToken || body.expo_push_token,
        expo_push_token: body.expoPushToken || body.expo_push_token,
      } : {}),
    };

    await prisma.setting.upsert({
      where: { key: metaKey },
      create: { key: metaKey, value: updatedMeta },
      update: { value: updatedMeta },
    });
  } catch {
    // Non-blocking fallback if settings table is missing
  }

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
            role: org.id === 'zone-001' && isHQRole(updatedMeta.role) ? 'HQ_ADMIN' : 'MEMBER',
            voicePart: voicePart || null,
            status: 'ACTIVE',
          },
        });

        try {
          updatedMeta = {
            ...updatedMeta,
            activeZoneId: org.id,
            zone_code: org.invitationCode || org.code || org.id,
            zoneCode: org.invitationCode || org.code || org.id,
          };
          await prisma.setting.upsert({
            where: { key: metaKey },
            create: { key: metaKey, value: updatedMeta },
            update: { value: updatedMeta },
          });
        } catch {}
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

  const formatted = formatUserProfile(updated, updatedMeta);
  broadcast('profile', userId, formatted);
  res.json({ success: true, message: 'Profile updated', data: formatted });
});

// PATCH /profiles/:userId/role & POST /profiles/:userId/role — Update member role (Zone Admin / HQ Admin / Church Admin)
const handleUpdateRole = async (req: any, res: any) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isHqAdmin =
      auth?.role === 'hq_admin' ||
      auth?.role === 'admin' ||
      auth?.role === 'super_admin' ||
      Boolean(auth?.hasHqAccess) ||
      Boolean(auth?.has_hq_access);
    const isZoneAdmin = auth?.role === 'zone_admin' || auth?.role === 'zone_coordinator';
    const isAdmin = isHqAdmin || isZoneAdmin || canManageTenant(auth?.role);

    if (!isAdmin) {
      res.status(403).json({ success: false, error: 'Forbidden: Only admins can change member roles' });
      return;
    }

    const rawRole = String(req.body?.role || '').toLowerCase().trim();
    if (!rawRole) {
      res.status(400).json({ success: false, error: 'role is required' });
      return;
    }

    if ((rawRole === 'hq_admin' || rawRole === 'super_admin') && !isHqAdmin) {
      res.status(403).json({ success: false, error: 'Only HQ Admins can assign HQ Admin role' });
      return;
    }

    // Check if target user has HQ credentials
    const metaKey = `profile_meta_${userId}`;
    const existingMeta = await prisma.setting.findUnique({ where: { key: metaKey } }).catch(() => null);
    const currentMeta: Record<string, any> =
      existingMeta?.value && typeof existingMeta.value === 'object' ? (existingMeta.value as Record<string, any>) : {};

    const existingMems = await prisma.membership.findMany({ where: { userId } }).catch(() => []);
    const targetIsHq =
      existingMems.some((m) => isHQRole(m.role)) ||
      isHQRole(currentMeta.role) ||
      Boolean(currentMeta.hasHqAccess) ||
      Boolean(currentMeta.has_hq_access);

    const isAssigningChurch =
      rawRole === 'church_admin' ||
      rawRole === 'church_coordinator' ||
      rawRole === 'group_admin';

    // If target user is an HQ Admin and being assigned as a church coordinator:
    // Retain HQ Admin privileges and add church to churches array!
    if (targetIsHq && isAssigningChurch) {
      const targetGroupId = req.body?.groupId || req.body?.churchId || null;
      const targetZoneId = req.body?.zoneId || null;

      const churchesMap = new Map<string, any>();
      if (Array.isArray(currentMeta.churches)) {
        for (const c of currentMeta.churches) {
          const cid = String(c?.id || c?.churchId || c?.groupId || '').trim();
          if (cid) churchesMap.set(cid, c);
        }
      }
      if (targetGroupId) {
        churchesMap.set(targetGroupId, {
          id: targetGroupId,
          name: req.body?.groupName || req.body?.churchName || 'Church',
          zoneId: targetZoneId || 'zone-001',
        });
      }

      const updatedMeta = {
        ...currentMeta,
        role: 'hq_admin',
        hasHqAccess: true,
        has_hq_access: true,
        administration: currentMeta.administration && currentMeta.administration !== 'Member' ? currentMeta.administration : 'HQ Admin',
        ...(targetGroupId ? { churchId: targetGroupId, church: req.body?.groupName || req.body?.churchName || currentMeta.church } : {}),
        churches: Array.from(churchesMap.values()),
      };

      await prisma.setting.upsert({
        where: { key: metaKey },
        create: { key: metaKey, value: updatedMeta },
        update: { value: updatedMeta },
      });

      // Update membership in targetZoneId (if not zone-001)
      if (targetZoneId && targetZoneId !== 'zone-001') {
        await prisma.membership.upsert({
          where: { userId_organizationId: { userId, organizationId: targetZoneId } },
          create: {
            id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            userId,
            organizationId: targetZoneId,
            groupId: targetGroupId,
            role: 'GROUP_ADMIN',
            status: 'ACTIVE',
          },
          update: {
            groupId: targetGroupId,
            role: 'GROUP_ADMIN',
            status: 'ACTIVE',
          },
        });
      }

      res.json({ success: true, message: 'HQ Admin church assignment saved', role: 'hq_admin' });
      return;
    }

    // Accidental demotion prevention: explicit confirmDemoteHq required to demote an HQ Admin
    if (targetIsHq && rawRole === 'member' && !req.body?.confirmDemoteHq) {
      res.status(400).json({ success: false, error: 'Explicit confirmation required to demote an HQ Admin' });
      return;
    }

    const dbRole =
      rawRole === 'hq_admin' || rawRole === 'super_admin'
        ? 'HQ_ADMIN'
        : rawRole === 'zone_admin' || rawRole === 'zone_coordinator'
          ? 'ZONE_ADMIN'
          : rawRole === 'church_admin' || rawRole === 'church_coordinator' || rawRole === 'group_admin'
            ? 'GROUP_ADMIN'
            : 'MEMBER';

    const metaRole =
      dbRole === 'HQ_ADMIN'
        ? 'hq_admin'
        : dbRole === 'ZONE_ADMIN'
          ? 'zone_coordinator'
          : dbRole === 'GROUP_ADMIN'
            ? 'church_coordinator'
            : 'member';

    const targetZoneId = req.body?.zoneId || req.tenant?.effectiveZoneId || auth?.zoneId || null;

    if (targetZoneId) {
      if (targetZoneId === 'zone-001' && targetIsHq && dbRole === 'GROUP_ADMIN') {
        // Retain HQ_ADMIN in zone-001
      } else {
        await prisma.membership.updateMany({
          where: { userId, organizationId: targetZoneId },
          data: { role: dbRole },
        });
      }
    } else {
      // If updating globally, never downgrade zone-001 HQ_ADMIN unless dbRole is explicitly HQ_ADMIN
      await prisma.membership.updateMany({
        where: {
          userId,
          ...(dbRole !== 'HQ_ADMIN' ? { organizationId: { not: 'zone-001' } } : {}),
        },
        data: { role: dbRole },
      });
    }

    const updatedMeta = {
      ...currentMeta,
      role: targetIsHq ? 'hq_admin' : metaRole,
      hasHqAccess: targetIsHq || metaRole === 'hq_admin',
      has_hq_access: targetIsHq || metaRole === 'hq_admin',
      administration: targetIsHq
        ? (currentMeta.administration && currentMeta.administration !== 'Member' ? currentMeta.administration : 'HQ Admin')
        : currentMeta.administration,
    };

    await prisma.setting.upsert({
      where: { key: metaKey },
      create: { key: metaKey, value: updatedMeta },
      update: { value: updatedMeta },
    });

    res.json({ success: true, message: 'Role updated successfully', role: updatedMeta.role });
  } catch (err: any) {
    console.error('[profiles/:userId/role]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update role' });
  }
};

router.patch('/:userId/role', requireAuth, handleUpdateRole);
router.post('/:userId/role', requireAuth, handleUpdateRole);

// POST /profiles/:userId/password
router.post('/:userId/password', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isOwner = auth?.userId === userId;
    const isHqAdmin = auth?.role === 'hq_admin' || auth?.role === 'admin' || auth?.role === 'super_admin';
    const isAdmin = isHqAdmin || canManageTenant(auth?.role);

    if (!isOwner && !isAdmin) {
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

// POST /profiles/:userId/remove-from-zone
router.post('/:userId/remove-from-zone', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isHqAdmin = auth?.role === 'hq_admin' || auth?.role === 'admin' || auth?.role === 'super_admin';
    const isAdmin =
      isHqAdmin ||
      canManageTenant(auth?.role) ||
      auth?.role === 'zone_admin' ||
      auth?.role === 'zone_coordinator';

    if (!isAdmin) {
      res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions' });
      return;
    }

    const targetZoneId = (
      req.body?.zoneId ||
      req.body?.organizationId ||
      req.query?.zoneId ||
      (req as any).tenant?.zoneId ||
      auth?.zoneId
    ) as string | undefined;

    if (targetZoneId) {
      await prisma.membership.deleteMany({
        where: {
          userId,
          organizationId: targetZoneId,
        },
      });
    } else {
      await prisma.membership.deleteMany({
        where: { userId },
      });
    }

    broadcast('profiles', userId, { type: 'removed_from_zone', id: userId, zoneId: targetZoneId });

    res.json({ success: true, message: 'Member removed from zone successfully' });
  } catch (err: any) {
    console.error('[profiles/:userId/remove-from-zone error]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to remove member from zone' });
  }
});

// DELETE /profiles/:userId
router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const auth = res.locals.auth;
    const isOwner = auth?.userId === userId;
    const isAdmin =
      auth?.role === 'hq_admin' ||
      auth?.role === 'admin' ||
      auth?.role === 'super_admin' ||
      auth?.role === 'zone_admin' ||
      auth?.role === 'zone_coordinator';

    if (!isOwner && !isAdmin) {
      res.status(403).json({ success: false, error: 'Forbidden: Insufficient permissions' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Clean up dependent records safely to prevent foreign key errors
    await prisma.membership.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.authCredential.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.userSongNote.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.mediaDoodle.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.userStatus.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.chatParticipant.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.setting.deleteMany({ where: { key: `profile_meta_${userId}` } }).catch(() => {});

    await prisma.user.delete({ where: { id: userId } });
    broadcast('profiles', userId, { type: 'deleted', id: userId });

    res.json({ success: true, message: 'Profile deleted successfully' });
  } catch (err: any) {
    console.error('[profiles/:userId DELETE error]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete profile' });
  }
});

export default router;
