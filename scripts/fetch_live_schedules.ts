import jwt from 'jsonwebtoken';

const JWT_SECRET = '9019eb38ca64aca5d3d6d1d27a299ccd5ebc132e7f4c2d87';

const token = jwt.sign(
  {
    sub: 'admin-test-user',
    role: 'super_admin',
    zoneId: 'zone-001',
    hasHqAccess: true,
    jti: 'test-jti-' + Date.now(),
  },
  JWT_SECRET,
  { expiresIn: '1h' }
);

async function main() {
  const url = 'https://rehearsalhub-api-production-6a17.up.railway.app/schedules';
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-api-key': 'lwsrh_production_secure_api_key_2026_x9z2',
      'x-scope': 'global',
    },
  });

  const json = await res.json();
  console.log('GET /schedules response:', JSON.stringify(json, null, 2));
}

main().catch(console.error);
