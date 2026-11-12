import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTenantScope } from './src/middleware/tenant.middleware';

test('HQ admins may select a zone from request scope', () => {
  const scope = resolveTenantScope(
    { headers: { 'x-zone-id': 'zone-006', 'x-scope': 'zone' }, query: {} } as any,
    { role: 'hq_admin', zoneId: null },
  );
  assert.equal(scope.effectiveZoneId, 'zone-006');
  assert.equal(scope.mode, 'zone');
  assert.equal(scope.isHQAdmin, true);
});

test('zone admins can switch effective zone via header/query', () => {
  const scope = resolveTenantScope(
    { headers: { 'x-zone-id': 'zone-007' }, query: { zoneId: 'zone-007' } } as any,
    { role: 'zone_admin', zoneId: 'zone-006' },
  );
  assert.equal(scope.effectiveZoneId, 'zone-007');
  assert.equal(scope.mode, 'zone');
});

test('church coordinators can switch to coordinated church via header', () => {
  const scope = resolveTenantScope(
    { headers: { 'x-zone-id': 'zone-007', 'x-church-id': 'church-2' }, query: {} } as any,
    { role: 'church_coordinator', zoneId: 'zone-006', churchId: 'church-1' },
  );
  assert.equal(scope.effectiveZoneId, 'zone-007');
  assert.equal(scope.effectiveChurchId, 'church-2');
  assert.equal(scope.mode, 'church');
});

test('members can select a zone from header/query when multi-zone', () => {
  const scope = resolveTenantScope(
    { headers: { 'x-zone-id': 'zone-007' }, query: { zoneId: 'zone-007' } } as any,
    { role: 'member', zoneId: null },
  );
  assert.equal(scope.effectiveZoneId, 'zone-007');
  assert.equal(scope.mode, 'zone');
});
