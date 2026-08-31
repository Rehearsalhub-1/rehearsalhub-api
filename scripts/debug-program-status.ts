import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: 'loveworld-singers-app' });
}
const db = admin.firestore();

async function main() {
  console.log('\n=== DB: Program status distribution ===');
  const dbProgs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT status, category, count(*) as count FROM programs GROUP BY status, category ORDER BY count DESC`
  );
  dbProgs.forEach(r => console.log(`status="${r.status}" category="${r.category}" count=${r.count}`));

  console.log('\n=== DB: Sample of 5 programs with their status/category/rawData.category ===');
  const samples = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, name, status, category, raw_data->>'category' as raw_category, raw_data->>'status' as raw_status FROM programs LIMIT 5`
  );
  samples.forEach(r => console.log(r.name, '| DB status:', r.status, '| DB category:', r.category, '| raw.category:', r.raw_category, '| raw.status:', r.raw_status));

  console.log('\n=== Firebase: praise_nights status distribution ===');
  const snap = await db.collection('praise_nights').get();
  const fbDist: Record<string, number> = {};
  snap.docs.forEach(doc => {
    const d = doc.data();
    const key = `category="${d.category}" status="${d.status}"`;
    fbDist[key] = (fbDist[key] || 0) + 1;
  });
  Object.entries(fbDist).forEach(([k, v]) => console.log(k, 'count:', v));

  await admin.app().delete();
  await pool.end();
}
main().catch(console.error);
