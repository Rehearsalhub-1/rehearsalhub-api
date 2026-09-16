export type PlatformRole =
  | 'super_admin'
  | 'admin'
  | 'hq_admin'
  | 'president'
  | 'director'
  | 'oftp'
  | 'executive'
  | 'boss'
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
  return normalized === 'super_admin' || normalized === 'admin' || normalized === 'hq_admin' ||
         normalized === 'president' || normalized === 'director' || normalized === 'oftp' ||
         normalized === 'executive' || normalized === 'boss'
}

export function canAccessAdmin(role: unknown): boolean {
  const normalized = normalizeRole(role)
  return isHQRole(normalized) ||
    normalized === 'org_admin' ||
    normalized === 'zone_admin' || normalized === 'zone_coordinator' || normalized === 'zone_leader' ||
    normalized === 'subgroup_admin' || normalized === 'subgroup_coordinator' || normalized === 'subgroup_leader' ||
    normalized === 'church_admin' || normalized === 'church_coordinator' || normalized === 'church_leader' ||
    normalized === 'choir_leader' || normalized === 'music_director' || normalized === 'leader'
}

export function canManageAllTenants(role: unknown): boolean {
  return isHQRole(role)
}

export function canManageTenant(role: unknown): boolean {
  const normalized = normalizeRole(role)
  return isHQRole(normalized) ||
    normalized === 'org_admin' ||
    normalized === 'zone_admin' || normalized === 'zone_coordinator' || normalized === 'zone_leader' ||
    normalized === 'subgroup_admin' || normalized === 'subgroup_coordinator' || normalized === 'subgroup_leader' ||
    normalized === 'church_admin' || normalized === 'church_coordinator' || normalized === 'church_leader' ||
    normalized === 'choir_leader' || normalized === 'music_director' || normalized === 'leader'
}

/**
 * Only Zone Admins and HQ Admins can create churches and appoint church coordinators.
 * Church coordinators are restricted to managing their own assigned church choir.
 */
export function canManageChurches(role: unknown): boolean {
  const normalized = normalizeRole(role)
  return isHQRole(normalized) || normalized === 'zone_admin' || normalized === 'zone_coordinator'
}
