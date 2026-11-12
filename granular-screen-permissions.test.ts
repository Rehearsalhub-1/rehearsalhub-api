process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_for_testing_12345';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost:5432/dummy';

import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccessAdmin } from './src/auth/permissions';
import { signAccessToken, verifyAccessToken } from './src/auth/token';
import { requireTenantAdmin } from './src/auth/auth.middleware';

test('canAccessAdmin grants access to members with adminScreens', () => {
  // Members with single screen
  assert.equal(canAccessAdmin('member', ['attendance']), true);
  assert.equal(canAccessAdmin('member', ['schedule']), true);
  assert.equal(canAccessAdmin('member', ['programs']), true);

  // Members with multiple screens
  assert.equal(canAccessAdmin('member', ['attendance', 'schedule']), true);

  // Members without admin screens
  assert.equal(canAccessAdmin('member', []), false);
  assert.equal(canAccessAdmin('member', undefined), false);
  assert.equal(canAccessAdmin('member'), false);

  // Standard Admins always have access regardless of adminScreens array
  assert.equal(canAccessAdmin('zone_admin', []), true);
  assert.equal(canAccessAdmin('zone_admin'), true);
  assert.equal(canAccessAdmin('church_admin', []), true);
  assert.equal(canAccessAdmin('church_coordinator'), true);
  assert.equal(canAccessAdmin('hq_admin', []), true);
  assert.equal(canAccessAdmin('super_admin'), true);
});

test('JWT signAccessToken and verifyAccessToken preserve adminScreens claim', () => {
  const token = signAccessToken({
    sub: 'usr_test_123',
    role: 'member',
    zoneId: 'zone-001',
    churchId: 'church-abc',
    adminScreens: ['attendance', 'schedule'],
  });

  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, 'usr_test_123');
  assert.equal(payload.role, 'member');
  assert.equal(payload.zoneId, 'zone-001');
  assert.equal(payload.churchId, 'church-abc');
  assert.deepEqual(payload.adminScreens, ['attendance', 'schedule']);
});

test('JWT without adminScreens retains undefined or empty claim cleanly', () => {
  const token = signAccessToken({
    sub: 'usr_full_admin',
    role: 'zone_admin',
    zoneId: 'zone-002',
  });

  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, 'usr_full_admin');
  assert.equal(payload.role, 'zone_admin');
  assert.equal(payload.adminScreens, undefined);
});

test('requireTenantAdmin middleware allows restricted screen members', (t, done) => {
  const req = {} as any;
  const res = {
    locals: {
      auth: {
        userId: 'usr_restricted_usher',
        role: 'member',
        adminScreens: ['attendance'],
      },
    },
  } as any;

  requireTenantAdmin(req, res, () => {
    // Next was called successfully!
    assert.ok(true, 'requireTenantAdmin called next() for member with adminScreens');
    done();
  });
});

test('requireTenantAdmin middleware blocks regular members without screens', async () => {
  const req = {} as any;
  let forbiddenCalled = false;
  let statusSet = 0;
  const res = {
    locals: {
      auth: {
        userId: 'usr_regular_singer',
        role: 'member',
        adminScreens: [],
      },
    },
    status: (code: number) => {
      statusSet = code;
      return {
        json: (data: any) => {
          forbiddenCalled = true;
        },
      };
    },
  } as any;

  let nextCalled = false;
  requireTenantAdmin(req, res, () => {
    nextCalled = true;
  });

  // Give any microtask/promise in fallback a chance
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(nextCalled, false, 'Regular member should NOT call next()');
});

test('requireTenantAdmin middleware allows standard zone_admin and hq_admin', (t, done) => {
  const req = {} as any;
  const res = {
    locals: {
      auth: {
        userId: 'usr_zone_lead',
        role: 'zone_admin',
      },
    },
  } as any;

  requireTenantAdmin(req, res, () => {
    assert.ok(true, 'requireTenantAdmin called next() for zone_admin');
    done();
  });
});
