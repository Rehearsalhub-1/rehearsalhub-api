export type PlatformRole =
  | 'super_admin'
  | 'admin'
  | 'hq_admin'
  | 'zone_admin'
  | 'zone_coordinator'
  | 'subgroup_admin'
  | 'subgroup_coordinator'
  | 'church_coordinator'
  | 'member'

export function normalizeRole(role: unknown): PlatformRole | string {
  return String(role || 'member').toLowerCase()
}

export function isHQRole(role: unknown): boolean {
  const normalized = normalizeRole(role)
  return normalized === 'super_admin' || normalized === 'admin' || normalized === 'hq_admin'
}

export function canAccessAdmin(role: unknown): boolean {
  const normalized = normalizeRole(role)
  return isHQRole(normalized) || normalized === 'zone_admin' || normalized === 'zone_coordinator' ||
    normalized === 'subgroup_admin' || normalized === 'subgroup_coordinator' || normalized === 'church_coordinator'
}

export function canManageAllTenants(role: unknown): boolean {
  return isHQRole(role)
}

export function canManageTenant(role: unknown): boolean {
  const normalized = normalizeRole(role)
  return isHQRole(normalized) || normalized === 'zone_admin' || normalized === 'zone_coordinator' ||
    normalized === 'subgroup_admin' || normalized === 'subgroup_coordinator' || normalized === 'church_coordinator'
}

/**
 * Only Zone Admins and HQ Admins can create churches and appoint church coordinators.
 * Church coordinators are restricted to managing their own assigned church choir.
 */
export function canManageChurches(role: unknown): boolean {
  const normalized = normalizeRole(role)
  return isHQRole(normalized) || normalized === 'zone_admin' || normalized === 'zone_coordinator'
}
