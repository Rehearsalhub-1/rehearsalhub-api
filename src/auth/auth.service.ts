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

const REFRESH_EXPIRES_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS ?? '30', 10);
function refreshExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_EXPIRES_DAYS);
  return d;
}

function asRaw(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function tokenRole(profile: { role: string | null; hasHqAccess?: boolean | null; rawData?: unknown }): string {
  // Check hasHqAccess from model field OR rawData (Firebase migrated profiles store it in rawData)
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

function zoneIdFromProfile(profile: { rawData: unknown }): string | null {
  const raw = asRaw(profile.rawData);
  const z = raw.zoneId || raw.zone_id || raw.zoneCode || raw.zone_code || null;
  return typeof z === 'string' ? z : null;
}

type InternalProfileRow = {
  id: string; email: string | null; first_name: string | null; last_name: string | null;
  role: string | null; has_hq_access: boolean | null; avatar_url: string | null;
  kingschat_id: string | null; profile_completed: boolean | null; created_at: Date | null;
  raw_data: unknown; updated_at: string | null; password_hash?: string | null;
};

function profileFromInternal(row: InternalProfileRow): any {
  // has_hq_access is not a real column in profiles table — it lives in raw_data
  const rawData = asRaw(row.raw_data);
  const hasHqAccess = row.has_hq_access === true
    || rawData.has_hq_access === true
    || rawData.has_hq_access === 'true'
    || rawData.hasHqAccess === true
    || rawData.hasHqAccess === 'true';
  // role also comes from raw_data for migrated Firebase profiles
  const role = row.role && row.role !== 'user' ? row.role : (String(rawData.role || '')||null) || row.role;
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role,
    hasHqAccess,
    has_hq_access: hasHqAccess,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    rawData: row.raw_data,
    kingschatId: row.kingschat_id,
    profileCompleted: row.profile_completed,
    updatedAt: row.updated_at,
  };
}

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  zoneId: string | null;
  firstName?: string | null;
  lastName?: string | null;
  hasHqAccess?: boolean;
  has_hq_access?: boolean;
};
export type AuthTokenResult = { accessToken: string; refreshToken: string; user: AuthUser };

const ADMIN_MEMBERSHIP_ROLES = new Set([
  'hq_admin', 'HQ_ADMIN', 'admin', 'ADMIN', 'super_admin', 'SUPER_ADMIN',
  'boss', 'BOSS', 'zone_admin', 'ZONE_ADMIN', 'zone_coordinator', 'ZONE_COORDINATOR',
  'coordinator', 'COORDINATOR', 'subgroup_admin', 'SUBGROUP_ADMIN',
  'subgroup_coordinator', 'SUBGROUP_COORDINATOR', 'church_coordinator', 'CHURCH_COORDINATOR',
]);

async function issueTokens(profile: any): Promise<AuthTokenResult> {
  const email = (profile.email || '').toLowerCase();

  // Check ALL memberships to determine the highest role across all orgs.
  // A user may be a member in one org and admin in another — always issue the highest role.
  let resolvedRole = tokenRole(profile);
  let resolvedZoneId = zoneIdFromProfile(profile);

  try {
    const memberships = await prisma.membership.findMany({
      where: { userId: profile.id, status: { in: ['ACTIVE', 'active'] } },
      include: { organization: { select: { id: true, isHq: true } } },
    });

    if (memberships.length > 0) {
      const hasAnyAdminRole = memberships.some(m =>
        ADMIN_MEMBERSHIP_ROLES.has(m.role || '') || m.hasHqAccess || m.organization?.isHq
      );
      const hqMembership = memberships.find(m =>
        m.hasHqAccess || m.organization?.isHq ||
        ['hq_admin','HQ_ADMIN','admin','ADMIN','super_admin','SUPER_ADMIN','boss','BOSS'].includes(m.role || '')
      );

      if (hqMembership) {
        resolvedRole = 'hq_admin';
        resolvedZoneId = resolvedZoneId || hqMembership.organizationId;
      } else if (hasAnyAdminRole) {
        const adminMembership = memberships.find(m => ADMIN_MEMBERSHIP_ROLES.has(m.role || ''));
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
  return {
    accessToken,
    refreshToken: rawRefresh,
    user: { id: profile.id, email, role: resolvedRole, zoneId: resolvedZoneId, firstName: profile.firstName, lastName: profile.lastName },
  };
}

export async function register(input: { email: string; password: string; firstName: string; lastName: string; zoneCode: string; designation?: string; kingschatId?: string }): Promise<AuthTokenResult | { pendingApproval: true; userId: string; zoneName?: string }> {
  if (!validatePasswordStrength(input.password)) throw new AuthError('Password must be at least 8 characters', 400);
  const email = input.email.toLowerCase().trim();
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(input.password);
  const cleanZoneCode = input.zoneCode.trim().toUpperCase();
  const isHQRequest = isHQZoneCode(cleanZoneCode);

  let profile: any;
  try {
    const rows = await prisma.$queryRawUnsafe<InternalProfileRow[]>(
      `SELECT * FROM auth_internal.register_user($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      id, email, passwordHash, input.firstName, input.lastName, cleanZoneCode, input.designation?.trim() || null, input.kingschatId?.trim() || null, isHQRequest,
    );
    profile = profileFromInternal(rows[0]);
  } catch (error: any) {
    if (error?.code === '23505') throw new AuthError('Email already registered', 409);
    throw error;
  }

  if (isHQRequest) return { pendingApproval: true, userId: id };
  return issueTokens(profile);
}

export async function login(identifier: string, password: string): Promise<AuthTokenResult> {
  const norm = (identifier || '').toLowerCase().trim().replace(/^@/, '');
  if (!norm) throw new AuthError('Identifier and password required');

  const candidateRows = await prisma.$queryRawUnsafe<InternalProfileRow[]>(
    `SELECT * FROM auth_internal.login_candidates($1)`, norm,
  );

  if (!candidateRows || candidateRows.length === 0) throw new AuthError('Invalid credentials');

  for (const row of candidateRows) {
    const candidate = profileFromInternal(row);
    if (row.password_hash && (await verifyPassword(password, row.password_hash))) {
      const raw = asRaw(candidate.rawData);
      if (raw.pending_hq_approval === true) throw new AuthError('PENDING_APPROVAL', 403);
      return issueTokens(candidate);
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

  const hasHq = user.memberships.some((m) => m.hasHqAccess || m.organization.isHq || isHQRole(m.role));
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
  first_name?: string | null;
  last_name?: string | null;
  avatar?: string | null;
  avatarUrl?: string | null;
  phone?: string | null;
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
    zoneMembers: Array<Record<string, unknown>>;
    hqMembers: Array<Record<string, unknown>>;
  };
};

export async function getMe(profileId: string): Promise<MeResult> {
  const user = await prisma.user.findUnique({
    where: { id: profileId },
    include: {
      memberships: {
        include: {
          organization: true,
          subgroup: true,
        },
      },
    },
  });
  if (!user) throw new AuthError('User not found', 404);

  const canonicalMemberships = user.memberships.map((m) => ({
    id: m.id,
    userId: user.id,
    organizationId: m.organizationId,
    subgroupId: m.subgroupId,
    role: m.role || 'MEMBER',
    status: m.status || 'ACTIVE',
    hasHqAccess: m.hasHqAccess,
    organization: {
      id: m.organization.id,
      name: m.organization.name,
      code: m.organization.code,
      country: m.organization.country,
      region: m.organization.region,
      isHq: m.organization.isHq,
      invitationCode: m.organization.invitationCode,
    },
    subgroup: m.subgroup
      ? {
          id: m.subgroup.id,
          name: m.subgroup.name,
          type: m.subgroup.type,
          status: m.subgroup.status,
        }
      : null,
  }));

  const zoneMembers = user.memberships
    .filter((m) => !m.organization.isHq)
    .map((m) => ({
      id: m.id,
      userId: user.id,
      zoneId: m.organizationId,
      zoneName: m.organization.name,
      subgroupId: m.subgroupId,
      subgroupName: m.subgroup?.name,
      role: (m.role || 'member').toLowerCase(),
      status: (m.status || 'active').toLowerCase(),
    }));

  const hqMembers = user.memberships
    .filter((m) => m.organization.isHq || m.hasHqAccess)
    .map((m) => ({
      id: m.id,
      userId: user.id,
      hqGroupId: m.organizationId,
      role: (m.role || 'member').toLowerCase(),
      status: (m.status || 'active').toLowerCase(),
      userEmail: user.email,
      userName: user.name,
    }));

  const hasHq = user.memberships.some((m) => m.hasHqAccess || m.organization.isHq || isHQRole(m.role));
  const hqMembership = user.memberships.find((m) => isHQRole(m.role));
  const primaryRole = (hqMembership?.role || user.memberships[0]?.role || 'member').toLowerCase();
  const primaryZoneId = hqMembership?.organizationId || user.memberships[0]?.organizationId || null;

  const raw = (user.rawData && typeof user.rawData === 'object' && !Array.isArray(user.rawData))
    ? (user.rawData as Record<string, any>)
    : {};

  const hiddenFeatures = raw.hidden_features || raw.hiddenFeatures || {};
  const canAccessArchive = !!(raw.can_access_archive || raw.canAccessArchive || raw.canSeeArchive || hasHq);
  const canAccessPreRehearsal = !!(raw.can_access_pre_rehearsal || raw.canAccessPreRehearsal);
  const canAnnotate = !!(raw.canAnnotate || raw.can_annotate || raw.canUseAnnotation);

  return {
    id: user.id,
    email: user.email || '',
    role: primaryRole,
    zoneId: primaryZoneId,
    firstName: user.firstName,
    lastName: user.lastName,
    first_name: user.firstName,
    last_name: user.lastName,
    avatar: user.avatarUrl || raw.profile_image_url || raw.avatar_url || raw.avatar || null,
    avatarUrl: user.avatarUrl || raw.profile_image_url || raw.avatar_url || raw.avatar || null,
    phone: user.phone || raw.phone_number || raw.phoneNumber || null,
    hasHqAccess: hasHq,
    has_hq_access: hasHq,
    canAccessArchive,
    can_access_archive: canAccessArchive,
    canAccessPreRehearsal,
    can_access_pre_rehearsal: canAccessPreRehearsal,
    canAnnotate,
    can_annotate: canAnnotate,
    hiddenFeatures,
    hidden_features: hiddenFeatures,
    memberships: canonicalMemberships,
    legacyMemberships: { zoneMembers, hqMembers },
    raw,
    rawData: raw,
  };
}

export async function resetPasswordForEmail(email: string, newPassword: string): Promise<void> {
  if (!validatePasswordStrength(newPassword)) throw new AuthError('Password must be at least 8 characters', 400);
  const passwordHash = await hashPassword(newPassword);
  const rows = await prisma.$queryRawUnsafe<Array<{ profile_id: string | null }>>(
    `SELECT auth_internal.reset_password($1, $2) AS profile_id`, email.toLowerCase().trim(), passwordHash,
  );
  if (!rows[0]?.profile_id) throw new AuthError('User not found', 404);
}

export async function getKingschatProfiles(kingschatId: string | null, email: string | null, username: string | null, selectedEmail: string | null): Promise<any[]> {
  const rows = await prisma.$queryRawUnsafe<InternalProfileRow[]>(
    `SELECT * FROM auth_internal.kingschat_profiles($1, $2, $3, $4)`, kingschatId, email, username, selectedEmail,
  );
  return rows.map(profileFromInternal);
}

export async function issueTokensForProfile(profile: any): Promise<AuthTokenResult> {
  return issueTokens(profile);
}
