import crypto from 'crypto';
import bcrypt from 'bcrypt';
import prisma from '../lib/prisma';
import { signAccessToken, generateRefreshToken } from './token';
import { verifyPassword, hashPassword, validatePasswordStrength } from './password';
import { revocationStore } from './revocation';
import { isHQRole } from './permissions';

const HQ_ZONE_CODES = new Set([
  'ZONE001', 'ZONE002', 'ZONE003', 'ZONE004', 'ZONE005',
  'ZONEORCH', 'ZONEPRES', 'ZONEPRES2', 'ZONEDIR', 'ZONEOFTP',
  'ZONEOFTD', 'ZONENAT', 'ZONEINT', 'ZONESA1',
]);

function isHQZoneCode(code: string): boolean {
  return HQ_ZONE_CODES.has(code.toUpperCase().trim());
}

export class AuthError extends Error {
  constructor(message: string, public readonly statusCode: number = 401) {
    super(message);
    this.name = 'AuthError';
  }
}

const REFRESH_EXPIRES_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS ?? '365', 10);
function refreshExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_EXPIRES_DAYS);
  return d;
}

function asRaw(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function tokenRole(profile: { role: string | null; hasHqAccess?: boolean | null; rawData?: unknown }): string {
  const raw = profile.rawData && typeof profile.rawData === 'object' && !Array.isArray(profile.rawData)
    ? (profile.rawData as Record<string, unknown>) : {};
  const hasHq = profile.hasHqAccess === true ||
    raw.has_hq_access === true || raw.has_hq_access === 'true' ||
    raw.hasHqAccess === true || raw.hasHqAccess === 'true';
  if (hasHq) return 'hq_admin';
  const r = (profile.role || String(raw.role || '')).toLowerCase();
  if (r === 'admin' || r === 'hq_admin' || r === 'super_admin' || r === 'boss') return 'hq_admin';
  if (r === 'zone_admin' || r === 'zone_coordinator' || r === 'subgroup_admin' || r === 'subgroup_coordinator') return 'zone_admin';
  if (r === 'church_coordinator') return 'church_coordinator';
  return 'member';
}

function zoneIdFromProfile(profile: { rawData?: unknown }): string | null {
  const raw = asRaw(profile?.rawData);
  const z = raw.zoneId || raw.zone_id || raw.zoneCode || raw.zone_code || null;
  return typeof z === 'string' ? z : null;
}

export function profileFromUser(user: any): any {
  if (!user) return null;
  const memberships = Array.isArray(user.memberships) ? user.memberships : [];
  const hasHq = memberships.some((m: any) => m.organization?.isHq || m.organizationId === 'zone-001' || isHQRole(m.role));
  const hqMembership = memberships.find((m: any) => isHQRole(m.role) || m.organization?.isHq || m.organizationId === 'zone-001');
  const primaryRole = (hqMembership?.role || memberships[0]?.role || 'member').toLowerCase();
  const primaryZoneId = hqMembership?.organizationId || memberships[0]?.organizationId || null;

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    first_name: user.firstName,
    last_name: user.lastName,
    avatarUrl: user.avatarUrl,
    avatar: user.avatarUrl,
    phone: user.phone,
    role: primaryRole,
    hasHqAccess: hasHq,
    has_hq_access: hasHq,
    kingschatId: user.kingschatId,
    profileCompleted: user.profileCompleted ?? true,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    zoneId: primaryZoneId,
    rawData: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      first_name: user.firstName,
      last_name: user.lastName,
      kingschatId: user.kingschatId,
      kingschat_id: user.kingschatId,
      role: primaryRole,
      hasHqAccess: hasHq,
      has_hq_access: hasHq,
      zoneId: primaryZoneId,
    },
  };
}

export type AuthUser = {
  id: string;
  uid?: string;
  userId?: string;
  email: string;
  role: string;
  zoneId: string | null;
  zone_id?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string;
  displayName?: string;
  username?: string | null;
  avatar?: string | null;
  avatarUrl?: string | null;
  profile_image_url?: string | null;
  phone?: string | null;
  phoneNumber?: string | null;
  hasHqAccess?: boolean;
  has_hq_access?: boolean;
  memberships?: any[];
};
export type AuthTokenResult = { accessToken: string; refreshToken: string; user: AuthUser };

const ADMIN_MEMBERSHIP_ROLES = new Set([
  'hq_admin', 'HQ_ADMIN', 'admin', 'ADMIN', 'super_admin', 'SUPER_ADMIN',
  'boss', 'BOSS', 'zone_admin', 'ZONE_ADMIN', 'zone_coordinator', 'ZONE_COORDINATOR',
  'coordinator', 'COORDINATOR', 'subgroup_admin', 'SUBGROUP_ADMIN',
  'subgroup_coordinator', 'SUBGROUP_COORDINATOR', 'church_coordinator', 'CHURCH_COORDINATOR',
]);

export async function fetchAllUserMemberships(userId: string, userRawData?: any) {
  // 1. Relational memberships from Prisma
  const dbMemberships = await prisma.membership.findMany({
    where: { userId, status: { in: ['ACTIVE', 'active', 'PENDING', 'pending'] } },
    include: {
      organization: true,
      group: true,
    },
  }).catch(() => []);

  // 2. Legacy zone_members and hq_members tables
  const [legacyZoneRows, legacyHqRows] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM zone_members WHERE user_id = $1`,
      userId
    ).catch(() => []),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM hq_members WHERE user_id = $1`,
      userId
    ).catch(() => []),
  ]);

  // 3. All organizations from database for name & code resolution
  const allOrgs = await prisma.organization.findMany().catch(() => []);
  const orgMap = new Map<string, any>();
  const orgCodeMap = new Map<string, any>();
  for (const o of allOrgs) {
    if (o.id) orgMap.set(o.id.toLowerCase(), o);
    const code = o.invitationCode || o.code;
    if (code) orgCodeMap.set(code.toUpperCase(), o);
  }

  const combinedMap = new Map<string, any>();

  // Ingest relational memberships
  for (const m of dbMemberships) {
    const orgId = m.organizationId;
    combinedMap.set(orgId.toLowerCase(), {
      id: m.id,
      userId: m.userId,
      organizationId: orgId,
      subgroupId: m.groupId,
      role: m.role || 'MEMBER',
      status: m.status || 'ACTIVE',
      hasHqAccess: (m as any).organization?.isHq || orgId === 'zone-001' || isHQRole(m.role || ''),
      organization: (m as any).organization
        ? {
            id: (m as any).organization.id,
            name: (m as any).organization.name,
            code: (m as any).organization.code,
            country: (m as any).organization.country,
            region: (m as any).organization.region,
            isHq: (m as any).organization.isHq,
            invitationCode: (m as any).organization.invitationCode,
          }
        : {
            id: orgId,
            name: orgId,
            code: orgId,
            country: null,
            region: null,
            isHq: orgId === 'zone-001',
            invitationCode: orgId,
          },
      subgroup: (m as any).group
        ? {
            id: (m as any).group.id,
            name: (m as any).group.name,
            type: (m as any).group.type,
            status: (m as any).group.status,
          }
        : null,
    });
  }

  // Ingest legacy zone_members
  for (const zm of legacyZoneRows) {
    const rawZId = zm.zone_id || zm.zoneId;
    if (rawZId) {
      const org: any = orgMap.get(String(rawZId).toLowerCase()) || orgCodeMap.get(String(rawZId).toUpperCase());
      const effectiveOrgId = org?.id || rawZId;
      const key = String(effectiveOrgId).toLowerCase();
      if (!combinedMap.has(key)) {
        combinedMap.set(key, {
          id: zm.id || `zm_${effectiveOrgId}`,
          userId,
          organizationId: effectiveOrgId,
          subgroupId: null,
          role: (zm.role || 'MEMBER').toUpperCase(),
          status: (zm.status || 'ACTIVE').toUpperCase(),
          hasHqAccess: org?.isHq || effectiveOrgId === 'zone-001',
          organization: org
            ? {
                id: org.id,
                name: org.name,
                code: org.code,
                country: org.country,
                region: org.region,
                isHq: org.isHq,
                invitationCode: org.invitationCode,
              }
            : {
                id: effectiveOrgId,
                name: effectiveOrgId,
                code: effectiveOrgId,
                country: null,
                region: null,
                isHq: effectiveOrgId === 'zone-001',
                invitationCode: effectiveOrgId,
              },
          subgroup: null,
        });
      }
    }
  }

  // Ingest legacy hq_members
  for (const hm of legacyHqRows) {
    const rawHqId = hm.hq_group_id || hm.hqGroupId || 'zone-001';
    if (rawHqId) {
      const org: any = orgMap.get(String(rawHqId).toLowerCase()) || orgCodeMap.get(String(rawHqId).toUpperCase());
      const effectiveOrgId = org?.id || rawHqId;
      const key = String(effectiveOrgId).toLowerCase();
      if (!combinedMap.has(key)) {
        combinedMap.set(key, {
          id: hm.id || `hm_${effectiveOrgId}`,
          userId,
          organizationId: effectiveOrgId,
          subgroupId: null,
          role: (hm.role || 'HQ_ADMIN').toUpperCase(),
          status: (hm.status || 'ACTIVE').toUpperCase(),
          hasHqAccess: true,
          organization: org
            ? {
                id: org.id,
                name: org.name,
                code: org.code,
                country: org.country,
                region: org.region,
                isHq: true,
                invitationCode: org.invitationCode,
              }
            : {
                id: effectiveOrgId,
                name: effectiveOrgId,
                code: effectiveOrgId,
                country: null,
                region: null,
                isHq: true,
                invitationCode: effectiveOrgId,
              },
          subgroup: null,
        });
      }
    }
  }

  // Ingest rawData zone_code if present and not yet captured
  const rawZoneCode = userRawData?.zone_code || userRawData?.zoneCode || userRawData?.zone_id || userRawData?.zoneId;
  if (rawZoneCode) {
    const org: any = orgMap.get(String(rawZoneCode).toLowerCase()) || orgCodeMap.get(String(rawZoneCode).toUpperCase());
    const effectiveOrgId = org?.id || rawZoneCode;
    const key = String(effectiveOrgId).toLowerCase();
    if (!combinedMap.has(key)) {
      combinedMap.set(key, {
        id: `raw_${effectiveOrgId}`,
        userId,
        organizationId: effectiveOrgId,
        subgroupId: null,
        role: 'MEMBER',
        status: 'ACTIVE',
        hasHqAccess: org?.isHq || effectiveOrgId === 'zone-001',
        organization: org
          ? {
              id: org.id,
              name: org.name,
              code: org.code,
              country: org.country,
              region: org.region,
              isHq: org.isHq,
              invitationCode: org.invitationCode,
            }
          : {
              id: effectiveOrgId,
              name: effectiveOrgId,
              code: effectiveOrgId,
              country: null,
              region: null,
              isHq: effectiveOrgId === 'zone-001',
              invitationCode: effectiveOrgId,
            },
        subgroup: null,
      });
    }
  }

  return Array.from(combinedMap.values());
}

async function issueTokens(profile: any): Promise<AuthTokenResult> {
  const email = (profile.email || '').toLowerCase();

  let resolvedRole = tokenRole(profile);
  let resolvedZoneId = zoneIdFromProfile(profile);
  let canonicalMemberships: any[] = [];

  try {
    canonicalMemberships = await fetchAllUserMemberships(profile.id, profile.rawData);

    if (canonicalMemberships.length > 0) {
      const hasAnyAdminRole = canonicalMemberships.some(m =>
        ADMIN_MEMBERSHIP_ROLES.has(m.role || '') || m.organization?.isHq || m.organizationId === 'zone-001'
      );
      const hqMembership = canonicalMemberships.find(m =>
        m.organization?.isHq || m.organizationId === 'zone-001' ||
        ['hq_admin','HQ_ADMIN','admin','ADMIN','super_admin','SUPER_ADMIN','boss','BOSS'].includes(m.role || '')
      );

      if (hqMembership) {
        resolvedRole = 'hq_admin';
        resolvedZoneId = resolvedZoneId || hqMembership.organizationId;
      } else if (hasAnyAdminRole) {
        const adminMembership = canonicalMemberships.find(m => ADMIN_MEMBERSHIP_ROLES.has(m.role || ''));
        resolvedRole = tokenRole({ ...profile, role: adminMembership?.role || resolvedRole });
        resolvedZoneId = resolvedZoneId || adminMembership?.organizationId || null;
      }
    }
  } catch {
    // Non-blocking — fall back to profile-based role
  }

  const rawRefresh = generateRefreshToken();
  const tokenHash = await bcrypt.hash(rawRefresh, 12);
  await prisma.refreshToken.create({
    data: { id: crypto.randomUUID(), userId: profile.id, tokenHash, expiresAt: refreshExpiresAt() },
  });
  const accessToken = signAccessToken({ sub: profile.id, role: resolvedRole, zoneId: resolvedZoneId ?? undefined });
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || email || 'Member';
  return {
    accessToken,
    refreshToken: rawRefresh,
    user: {
      id: profile.id,
      uid: profile.id,
      userId: profile.id,
      email,
      role: resolvedRole,
      zoneId: resolvedZoneId,
      zone_id: resolvedZoneId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      first_name: profile.firstName,
      last_name: profile.lastName,
      name: fullName,
      displayName: fullName,
      username: profile.username || (email ? email.split('@')[0] : null),
      avatar: profile.avatarUrl || profile.avatar || null,
      avatarUrl: profile.avatarUrl || profile.avatar || null,
      profile_image_url: profile.avatarUrl || profile.avatar || null,
      phone: profile.phone || null,
      phoneNumber: profile.phone || null,
      hasHqAccess: profile.hasHqAccess || false,
      has_hq_access: profile.hasHqAccess || false,
      memberships: canonicalMemberships,
    },
  };
}

export async function register(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  zoneCode: string;
  designation?: string;
  kingschatId?: string;
}): Promise<AuthTokenResult | { pendingApproval: true; userId: string; zoneName?: string }> {
  if (!validatePasswordStrength(input.password)) throw new AuthError('Password must be at least 8 characters', 400);
  const email = input.email.toLowerCase().trim();
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(input.password);
  const cleanZoneCode = input.zoneCode.trim().toUpperCase();
  const isHQRequest = isHQZoneCode(cleanZoneCode);

  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  });
  if (existing) throw new AuthError('Email already registered', 409);

  const org = await prisma.organization.findFirst({
    where: {
      OR: [
        { code: { equals: cleanZoneCode, mode: 'insensitive' } },
        { invitationCode: { equals: cleanZoneCode, mode: 'insensitive' } },
      ],
    },
  });

  const createdUser = await prisma.user.create({
    data: {
      id,
      email,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      kingschatId: input.kingschatId?.trim() || null,
      profileCompleted: true,
      credential: {
        create: {
          passwordHash,
        },
      },
      ...(org
        ? {
            memberships: {
              create: {
                organizationId: org.id,
                role: 'MEMBER',
                status: isHQRequest ? 'PENDING' : 'ACTIVE',
              },
            },
          }
        : {}),
    },
    include: {
      credential: true,
      memberships: { include: { organization: true, group: true } },
    },
  });

  if (isHQRequest) {
    try {
      await prisma.notification.create({
        data: {
          id: crypto.randomUUID(),
          type: 'join_request',
          title: 'New HQ Join Request',
          body: `${input.firstName.trim()} ${input.lastName.trim()} (${email}) has requested to join an HQ group using zone code ${cleanZoneCode}. Please review and approve or reject their account.`,
          category: 'join_request',
          priority: 'high',
          senderId: id,
        },
      });
    } catch {
      // Non-blocking notification
    }
    return { pendingApproval: true, userId: id };
  }

  const profile = profileFromUser(createdUser);
  return issueTokens(profile);
}

export async function login(identifier: string, password: string): Promise<AuthTokenResult> {
  const norm = (identifier || '').toLowerCase().trim().replace(/^@/, '');
  if (!norm) throw new AuthError('Identifier and password required');

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { equals: norm, mode: 'insensitive' } },
        { kingschatId: { equals: norm, mode: 'insensitive' } },
        { firstName: { equals: norm, mode: 'insensitive' } },
        { lastName: { equals: norm, mode: 'insensitive' } },
      ],
    },
    include: {
      credential: true,
      memberships: { include: { organization: true, group: true } },
    },
    take: 10,
  });

  if (!users || users.length === 0) {
    throw new AuthError('Invalid credentials');
  }

  for (const user of users) {
    if (user.credential?.passwordHash && (await verifyPassword(password, user.credential.passwordHash))) {
      const isPending = user.memberships.some(m => m.status === 'PENDING' || m.status === 'pending');
      if (isPending && user.memberships.length > 0 && user.memberships.every(m => m.status === 'PENDING' || m.status === 'pending')) {
        throw new AuthError('PENDING_APPROVAL', 403);
      }
      const profile = profileFromUser(user);
      return issueTokens(profile);
    }
  }

  throw new AuthError('Invalid credentials');
}

export async function refresh(rawToken: string, profileId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const rows = await prisma.refreshToken.findMany({ where: { userId: profileId } });
  let matchedRow: (typeof rows)[number] | undefined;
  for (const row of rows) {
    if (await bcrypt.compare(rawToken, row.tokenHash)) { matchedRow = row; break; }
  }

  if (!matchedRow) {
    throw new AuthError('Invalid or reused refresh token');
  }
  if (matchedRow.expiresAt <= new Date()) {
    await prisma.refreshToken.deleteMany({ where: { id: matchedRow.id } });
    throw new AuthError('Refresh token expired');
  }

  await prisma.refreshToken.deleteMany({ where: { id: matchedRow.id } });

  const user = await prisma.user.findUnique({
    where: { id: profileId },
    include: {
      memberships: {
        include: { organization: true },
      },
    },
  });
  if (!user) throw new AuthError('User not found');

  const hasHq = user.memberships.some((m) => m.organization.isHq || m.organizationId === 'zone-001' || isHQRole(m.role));
  const hqMembership = user.memberships.find((m) => isHQRole(m.role));
  const primaryRole = (hqMembership?.role || user.memberships[0]?.role || 'member').toLowerCase();
  const primaryZoneId = hqMembership?.organizationId || user.memberships[0]?.organizationId || null;
  const normalizedRole = tokenRole({ role: primaryRole, hasHqAccess: hasHq });

  const newRaw = generateRefreshToken();
  const newHash = await bcrypt.hash(newRaw, 12);
  await prisma.refreshToken.create({
    data: {
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash: newHash,
      expiresAt: refreshExpiresAt(),
    },
  });

  const accessToken = signAccessToken({
    sub: user.id,
    role: normalizedRole,
    zoneId: primaryZoneId ?? undefined,
  });
  return { accessToken, refreshToken: newRaw };
}

export async function logout(jti: string, exp: number, profileId: string, rawRefreshToken?: string): Promise<void> {
  revocationStore.revoke(jti, new Date(exp * 1000));
  if (rawRefreshToken && profileId) {
    const rows = await prisma.refreshToken.findMany({ where: { userId: profileId } });
    for (const row of rows) {
      if (await bcrypt.compare(rawRefreshToken, row.tokenHash)) {
        await prisma.refreshToken.deleteMany({ where: { id: row.id } });
        break;
      }
    }
  }
}

export type MeResult = AuthUser & {
  uid?: string;
  userId?: string;
  name?: string;
  displayName?: string;
  username?: string | null;
  alias?: string | null;
  middleName?: string | null;
  middle_name?: string | null;
  gender?: string | null;
  birthday?: string | null;
  region?: string | null;
  church?: string | null;
  designation?: string | null;
  administration?: string | null;
  voicePart?: string | null;
  voice_part?: string | null;
  zoneCode?: string | null;
  zone_code?: string | null;
  zoneName?: string | null;
  zone_name?: string | null;
  zone_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  avatar?: string | null;
  avatarUrl?: string | null;
  profile_image_url?: string | null;
  phone?: string | null;
  phoneNumber?: string | null;
  phone_number?: string | null;
  canAccessArchive?: boolean;
  can_access_archive?: boolean;
  canAccessPreRehearsal?: boolean;
  can_access_pre_rehearsal?: boolean;
  canAnnotate?: boolean;
  can_annotate?: boolean;
  hiddenFeatures?: Record<string, boolean>;
  hidden_features?: Record<string, boolean>;
  raw?: Record<string, any>;
  rawData?: Record<string, any>;
  memberships: Array<{
    id: string;
    userId: string;
    organizationId: string;
    subgroupId: string | null;
    role: string;
    status: string;
    hasHqAccess: boolean;
    organization: {
      id: string;
      name: string | null;
      code: string | null;
      country: string | null;
      region: string | null;
      isHq: boolean;
      invitationCode: string | null;
    };
    subgroup: {
      id: string;
      name: string;
      type: string | null;
      status: string | null;
    } | null;
  }>;
  legacyMemberships?: {
    zoneMembers: Array<{
      id: string;
      userId: string;
      zoneId: string;
      zoneName: string;
      subgroupId: string | null;
      subgroupName?: string;
      role: string;
      status: string;
    }>;
    hqMembers: Array<{
      id: string;
      userId: string;
      hqGroupId: string;
      role: string;
      status: string;
      userEmail?: string | null;
      userName?: string;
    }>;
  };
};

export async function getMe(profileId: string): Promise<MeResult> {
  const [user, metaRow] = await Promise.all([
    prisma.user.findUnique({
      where: { id: profileId },
    }),
    prisma.setting.findUnique({ where: { key: `profile_meta_${profileId}` } }),
  ]);
  if (!user) throw new AuthError('User not found', 404);

  const meta = (metaRow?.value as Record<string, any>) || {};
  const canonicalMemberships = await fetchAllUserMemberships(profileId);

  const zoneMembers = canonicalMemberships
    .filter((m) => !m.hasHqAccess)
    .map((m) => ({
      id: m.id,
      userId: user.id,
      zoneId: m.organizationId,
      zoneName: m.organization?.name || m.organizationId,
      subgroupId: m.subgroupId,
      subgroupName: m.subgroup?.name,
      role: (m.role || 'member').toLowerCase(),
      status: (m.status || 'active').toLowerCase(),
    }));

  const hqMembers = canonicalMemberships
    .filter((m) => m.hasHqAccess)
    .map((m) => ({
      id: m.id,
      userId: user.id,
      hqGroupId: m.organizationId,
      role: (m.role || 'member').toLowerCase(),
      status: (m.status || 'active').toLowerCase(),
      userEmail: user.email,
      userName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Member',
    }));

  const hasHq = canonicalMemberships.some((m) => m.hasHqAccess || isHQRole(m.role));
  const hqMembership = canonicalMemberships.find((m) => isHQRole(m.role));
  const primaryRole = (hqMembership?.role || canonicalMemberships[0]?.role || 'member').toLowerCase();
  const primaryZoneId = hqMembership?.organizationId || canonicalMemberships[0]?.organizationId || null;
  const primaryOrg = canonicalMemberships[0]?.organization;
  const zoneCode = primaryOrg?.code || primaryOrg?.invitationCode || primaryZoneId;
  const zoneName = primaryOrg?.name || primaryZoneId;

  const username = meta.username || meta.alias || (user.email ? user.email.split('@')[0] : null);
  const middleName = meta.middle_name || meta.middleName || null;
  const gender = meta.gender || null;
  const birthday = meta.birthday || null;
  const region = meta.region || primaryOrg?.region || null;
  const church = meta.church || canonicalMemberships[0]?.subgroup?.name || null;
  const designation = meta.designation || 'Member';
  const administration = meta.administration || (primaryRole === 'admin' ? 'Admin' : 'Member');
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Member';

  const canAccessArchive = true;
  const canAccessPreRehearsal = true;
  const canAnnotate = true;

  return {
    id: user.id,
    uid: user.id,
    userId: user.id,
    email: user.email || '',
    role: primaryRole,
    zoneId: primaryZoneId,
    zone_id: primaryZoneId,
    zoneCode,
    zone_code: zoneCode,
    zoneName,
    zone_name: zoneName,
    firstName: user.firstName,
    lastName: user.lastName,
    first_name: user.firstName,
    last_name: user.lastName,
    middleName,
    middle_name: middleName,
    username,
    alias: username,
    name: fullName,
    displayName: fullName,
    gender,
    birthday,
    region,
    church,
    designation,
    administration,
    voicePart: designation,
    voice_part: designation,
    avatar: user.avatarUrl || null,
    avatarUrl: user.avatarUrl || null,
    profile_image_url: user.avatarUrl || null,
    phone: user.phone || null,
    phoneNumber: user.phone || null,
    phone_number: user.phone || null,
    hasHqAccess: hasHq,
    has_hq_access: hasHq,
    canAccessArchive,
    can_access_archive: canAccessArchive,
    canAccessPreRehearsal,
    can_access_pre_rehearsal: canAccessPreRehearsal,
    canAnnotate,
    can_annotate: canAnnotate,
    hiddenFeatures: {},
    hidden_features: {},
    memberships: canonicalMemberships,
    legacyMemberships: { zoneMembers, hqMembers },
    raw: meta,
    rawData: meta,
  };
}

export async function resetPasswordForEmail(email: string, newPassword: string): Promise<void> {
  if (!validatePasswordStrength(newPassword)) throw new AuthError('Password must be at least 8 characters', 400);
  const cleanEmail = email.toLowerCase().trim();
  const passwordHash = await hashPassword(newPassword);

  const user = await prisma.user.findFirst({
    where: { email: { equals: cleanEmail, mode: 'insensitive' } },
  });
  if (!user) throw new AuthError('User not found', 404);

  await prisma.authCredential.upsert({
    where: { userId: user.id },
    create: { userId: user.id, passwordHash },
    update: { passwordHash },
  });

  await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
}

export async function getKingschatProfiles(
  kingschatId: string | null,
  email: string | null,
  username: string | null,
  selectedEmail: string | null
): Promise<any[]> {
  const orConditions: any[] = [];
  if (kingschatId) {
    orConditions.push({ kingschatId: { equals: kingschatId, mode: 'insensitive' } });
  }
  if (email) {
    orConditions.push({ email: { equals: email.toLowerCase().trim(), mode: 'insensitive' } });
  }
  if (selectedEmail) {
    orConditions.push({ email: { equals: selectedEmail.toLowerCase().trim(), mode: 'insensitive' } });
  }
  if (username) {
    orConditions.push({ email: { startsWith: `${username.toLowerCase().trim()}@`, mode: 'insensitive' } });
  }

  if (orConditions.length === 0) return [];

  let users = await prisma.user.findMany({
    where: {
      OR: orConditions,
    },
    include: {
      credential: true,
      memberships: { include: { organization: true, group: true } },
    },
    take: 10,
  });

  if (selectedEmail) {
    users = users.filter(u => u.email?.toLowerCase().trim() === selectedEmail.toLowerCase().trim());
  }

  if (users.length === 1 && kingschatId && !users[0].kingschatId) {
    try {
      await prisma.user.update({
        where: { id: users[0].id },
        data: { kingschatId },
      });
      users[0].kingschatId = kingschatId;
    } catch {}
  }

  return users.map(profileFromUser);
}

export async function issueTokensForProfile(profile: any): Promise<AuthTokenResult> {
  return issueTokens(profile);
}
