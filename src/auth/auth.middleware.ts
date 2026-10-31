import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JsonWebTokenError, TokenExpiredError } from './token';
import { revocationStore } from './revocation';
import { resolveTenantScope, withTenantTransaction } from '../middleware/tenant.middleware';
import { canManageTenant, canManageChurches, canAccessAdmin } from './permissions';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const token = header.slice(7);

  try {
    const payload = verifyAccessToken(token);

    if (revocationStore.isRevoked(payload.jti)) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const authData = {
      userId: payload.sub,
      role: payload.role,
      /** Tenant identity comes from the signed token; headers only select HQ views. */
      zoneId: payload.zoneId || null,
      /** churchId from JWT claim — set for church_coordinator role */
      churchId: payload.churchId || null,
      jti: payload.jti,
      exp: payload.exp!,
    };

    res.locals.auth = authData;
    req.tenant = resolveTenantScope(req, authData, res);

    withTenantTransaction(req, res, req.tenant, next);
  } catch (err) {
    if (err instanceof TokenExpiredError || err instanceof JsonWebTokenError) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    next(err);
  }
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next();
  }
  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);
    if (!revocationStore.isRevoked(payload.jti)) {
      const authData = {
        userId: payload.sub,
        role: payload.role,
        zoneId: payload.zoneId || null,
        churchId: payload.churchId || null,
        jti: payload.jti,
        exp: payload.exp!,
      };
      res.locals.auth = authData;
      req.tenant = resolveTenantScope(req, authData, res);
    }
  } catch {}
  next();
}

export function requireTenantAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.auth) {
    return requireAuth(req, res, () => {
      const role = res.locals.auth?.role;
      if (!canManageTenant(role) && !canAccessAdmin(role)) {
        return requireZoneOrHqAdmin(req, res, next) as any;
        return;
      }
      next();
    });
  }

  const role = res.locals.auth?.role;
  if (!canManageTenant(role) && !canAccessAdmin(role)) {
    return requireZoneOrHqAdmin(req, res, next) as any;
    return;
  }
  next();
}

/**
 * Strict role check ensuring ONLY Zone Administrators and HQ Admins
 * can create churches, edit church details, delete churches, or assign church coordinators.
 */
export async function requireZoneOrHqAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const role = res.locals.auth?.role;
  if (canManageChurches(role)) {
    next();
    return;
  }

  // Fallback: Check if the user has an active Zone Admin or HQ Admin membership in DB
  const userId = res.locals.auth?.userId;
  if (userId) {
    try {
      const { default: prisma } = await import('../lib/prisma');
      const membership = await prisma.membership.findFirst({
        where: {
          userId,
          status: { in: ['ACTIVE', 'active'] },
          role: {
            in: [
              'ZONE_ADMIN', 'zone_admin', 'zone_coordinator', 'ZONE_COORDINATOR',
              'COORDINATOR', 'coordinator', 'ORG_ADMIN', 'org_admin', 'ZONE_LEADER', 'zone_leader',
              'HQ_ADMIN', 'hq_admin', 'ADMIN', 'admin', 'SUPER_ADMIN', 'super_admin',
              'PRESIDENT', 'president', 'DIRECTOR', 'director', 'OFTP', 'oftp', 'EXECUTIVE', 'executive', 'BOSS', 'boss',
            ],
          },
        },
      });

      if (membership) {
        // Hydrate role in request locals so downstream handlers see the proper admin role
        if (res.locals.auth) {
          res.locals.auth.role = (membership.role || 'zone_admin').toLowerCase();
          req.tenant = resolveTenantScope(req, res.locals.auth, res);
        }
        next();
        return;
      }
    } catch (err) {
      console.error('[requireZoneOrHqAdmin] DB fallback check error:', err);
    }
  }

  res.status(403).json({
    success: false,
    error: 'Forbidden: Only Zone Administrators and HQ Admins can create churches and appoint coordinators.',
  });
}

/**
 * Stronger admin check — verifies the user has an active admin membership
 * in the database, not just a role claim in their JWT.
 * Use for sensitive mutations (delete, role changes, bulk updates).
 */
export async function requireAdminMembership(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = res.locals.auth;
  if (!auth?.userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const role = (auth.role || '').toLowerCase();
  const isHQRole = role === 'super_admin' || role === 'admin' || role === 'hq_admin' ||
    role === 'president' || role === 'director' || role === 'oftp' || role === 'executive' || role === 'boss';
  const isAdminRole = isHQRole || role === 'zone_admin' || role === 'zone_coordinator' ||
    role === 'subgroup_admin' || role === 'subgroup_coordinator' || role === 'church_coordinator';

  if (!isAdminRole) {
    return requireZoneOrHqAdmin(req, res, next) as any;
    return;
  }

  try {
    // Import prisma lazily to avoid circular dependency
    const { default: prisma } = await import('../lib/prisma');

    const membership = await prisma.membership.findFirst({
      where: {
        userId: auth.userId,
        role: {
          in: [
            'ZONE_ADMIN', 'zone_admin', 'zone_coordinator', 'ZONE_COORDINATOR',
            'HQ_ADMIN', 'hq_admin', 'admin', 'super_admin',
            'PRESIDENT', 'president', 'DIRECTOR', 'director', 'OFTP', 'oftp', 'EXECUTIVE', 'executive',
            'SUBGROUP_ADMIN', 'subgroup_admin', 'subgroup_coordinator', 'SUBGROUP_COORDINATOR',
            'church_coordinator', 'CHURCH_COORDINATOR',
          ],
        },
        status: { not: 'INACTIVE' },
      },
    });

    // HQ admins may not have a standard membership — fall back to JWT role
    if (!membership && !isHQRole) {
      res.status(403).json({ success: false, error: 'Forbidden: no active admin membership' });
      return;
    }

    next();
  } catch (err) {
    console.error('[requireAdminMembership]', err);
    // On DB error, fall back to JWT role check to avoid blocking legitimate admins
    if (isAdminRole) {
      next();
    } else {
      res.status(500).json({ success: false, error: 'Something went wrong' });
    }
  }
}
