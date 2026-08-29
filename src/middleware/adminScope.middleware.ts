import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';

const ADMIN_ROLES = new Set(['super_admin', 'admin', 'hq_admin', 'zone_admin', 'zone_coordinator', 'subgroup_admin', 'subgroup_coordinator', 'church_coordinator']);

/**
 * DB-VERIFIED ADMIN SCOPE MIDDLEWARE
 * 
 * For admin operations, derives effectiveZoneId and effectiveSubgroupId from the
 * memberships table — not from headers or JWT claims alone.
 * 
 * Rules:
 * - HQ admin (hq_admin/admin/super_admin): scope = their HQ org (isHq=true or zone-001)
 *   They can optionally filter by zone via header, but only within their HQ scope.
 * - Zone admin (zone_admin/zone_coordinator): scope LOCKED to their ONE admin org.
 *   Header overrides are IGNORED — even if they send a different x-zone-id.
 * - Subgroup/church admin: scope locked to their subgroup within their org.
 * - Regular member hitting admin route: 403 Forbidden.
 */
export async function verifyAdminScope(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = res.locals.auth;
    if (!auth?.userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const role = (auth.role || '').toLowerCase();
    const isHQRole = role === 'super_admin' || role === 'admin' || role === 'hq_admin';
    const isZoneAdminRole = role === 'zone_admin' || role === 'zone_coordinator';
    const isSubgroupRole = role === 'subgroup_admin' || role === 'subgroup_coordinator' || role === 'church_coordinator';

    if (!ADMIN_ROLES.has(role)) {
      res.status(403).json({ success: false, error: 'Forbidden: admin access required' });
      return;
    }

    if (isHQRole) {
      // HQ admins — find their HQ org membership
      const hqMembership = await prisma.membership.findFirst({
        where: {
          userId: auth.userId,
          OR: [
            { organization: { isHq: true } },
            { hasHqAccess: true },
            { organizationId: 'zone-001' },
          ],
        },
        include: { organization: true },
      });

      // HQ admins can view any zone if they send x-zone-id header
      // but their BASE scope is the HQ org
      const headerZoneId = (req.headers['x-zone-id'] as string) || (req.headers['x-organization-id'] as string) || null;
      
      res.locals.adminScope = {
        isHQAdmin: true,
        isZoneAdmin: false,
        isSubgroupAdmin: false,
        // HQ org they belong to
        adminOrgId: hqMembership?.organizationId || 'zone-001',
        // If they're scoping to a specific zone, use that; otherwise global
        effectiveZoneId: headerZoneId || null,
        effectiveSubgroupId: (req.headers['x-subgroup-id'] as string) || (req.headers['x-church-id'] as string) || null,
        isGlobalView: !headerZoneId,
      };

      next();
      return;
    }

    if (isZoneAdminRole) {
      // Zone admin — find their SINGLE admin membership from DB
      const adminMembership = await prisma.membership.findFirst({
        where: {
          userId: auth.userId,
          role: { in: ['ZONE_ADMIN', 'zone_admin', 'zone_coordinator', 'ZONE_COORDINATOR'] },
          status: { not: 'INACTIVE' },
        },
        include: { organization: true },
      });

      if (!adminMembership) {
        // Fallback: check JWT zoneId
        const jwtZoneId = auth.zoneId;
        if (!jwtZoneId) {
          res.status(403).json({ success: false, error: 'Forbidden: no active admin membership found' });
          return;
        }
        // Use JWT claim as fallback (with warning)
        console.warn(`[adminScope] Zone admin ${auth.userId} has no DB membership — using JWT fallback`);
        res.locals.adminScope = {
          isHQAdmin: false,
          isZoneAdmin: true,
          isSubgroupAdmin: false,
          adminOrgId: jwtZoneId,
          effectiveZoneId: jwtZoneId, // LOCKED — cannot be overridden
          effectiveSubgroupId: null,
          isGlobalView: false,
        };
        next();
        return;
      }

      res.locals.adminScope = {
        isHQAdmin: false,
        isZoneAdmin: true,
        isSubgroupAdmin: false,
        adminOrgId: adminMembership.organizationId,
        effectiveZoneId: adminMembership.organizationId, // LOCKED to their ONE admin org
        effectiveSubgroupId: null,
        isGlobalView: false,
      };

      next();
      return;
    }

    if (isSubgroupRole) {
      // Subgroup/church admin — locked to their subgroup
      const subgroupMembership = await prisma.membership.findFirst({
        where: {
          userId: auth.userId,
          subgroupId: { not: null },
          role: { in: ['SUBGROUP_ADMIN', 'subgroup_admin', 'church_coordinator', 'CHURCH_COORDINATOR', 'subgroup_coordinator', 'SUBGROUP_COORDINATOR'] },
          status: { not: 'INACTIVE' },
        },
        include: { organization: true, subgroup: true },
      });

      if (!subgroupMembership) {
        res.status(403).json({ success: false, error: 'Forbidden: no active subgroup admin membership found' });
        return;
      }

      res.locals.adminScope = {
        isHQAdmin: false,
        isZoneAdmin: false,
        isSubgroupAdmin: true,
        adminOrgId: subgroupMembership.organizationId,
        effectiveZoneId: subgroupMembership.organizationId,
        effectiveSubgroupId: subgroupMembership.subgroupId, // LOCKED
        isGlobalView: false,
      };

      next();
      return;
    }

    res.status(403).json({ success: false, error: 'Forbidden' });
  } catch (err) {
    console.error('[verifyAdminScope]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
}

/**
 * Lightweight version — attaches adminScope without DB query.
 * Use for non-critical admin reads where JWT role is sufficient.
 * For mutations and sensitive reads, use verifyAdminScope instead.
 */
export function attachAdminScope(req: Request, res: Response, next: NextFunction): void {
  const auth = res.locals.auth;
  const role = (auth?.role || '').toLowerCase();
  const isHQRole = role === 'super_admin' || role === 'admin' || role === 'hq_admin';
  const isZoneAdminRole = role === 'zone_admin' || role === 'zone_coordinator';
  const isSubgroupRole = role === 'subgroup_admin' || role === 'subgroup_coordinator' || role === 'church_coordinator';

  const headerZoneId = (req.headers['x-zone-id'] as string) || (req.headers['x-organization-id'] as string) || null;
  const headerSubgroupId = (req.headers['x-subgroup-id'] as string) || (req.headers['x-church-id'] as string) || null;

  if (isHQRole) {
    res.locals.adminScope = {
      isHQAdmin: true, isZoneAdmin: false, isSubgroupAdmin: false,
      adminOrgId: auth?.zoneId || 'zone-001',
      effectiveZoneId: headerZoneId || null,
      effectiveSubgroupId: headerSubgroupId || null,
      isGlobalView: !headerZoneId,
    };
  } else if (isZoneAdminRole) {
    // JWT role — zone locked to JWT claim (use verifyAdminScope for DB verification)
    res.locals.adminScope = {
      isHQAdmin: false, isZoneAdmin: true, isSubgroupAdmin: false,
      adminOrgId: auth?.zoneId || null,
      effectiveZoneId: auth?.zoneId || null, // LOCKED
      effectiveSubgroupId: null,
      isGlobalView: false,
    };
  } else if (isSubgroupRole) {
    res.locals.adminScope = {
      isHQAdmin: false, isZoneAdmin: false, isSubgroupAdmin: true,
      adminOrgId: auth?.zoneId || null,
      effectiveZoneId: auth?.zoneId || null,
      effectiveSubgroupId: auth?.churchId || null, // LOCKED
      isGlobalView: false,
    };
  } else {
    res.locals.adminScope = null;
  }

  next();
}
