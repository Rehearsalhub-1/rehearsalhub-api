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
  console.log('\n=== Firebase master_programs (first 3) ===');
  const snap = await db.collection('master_programs').limit(3).get();
  snap.docs.forEach(doc => {
    console.log('\nID:', doc.id);
    const d = doc.data();
    console.log('Fields:', JSON.stringify({ name: d.name, description: d.description, songIds: d.songIds?.slice(0,3), sortOrder: d.sortOrder, createdAt: d.createdAt }, null, 2));
  });

  console.log('\n=== DB programs with organizationId zone-001 (first 5) ===');
  const dbProgs = await prisma.program.findMany({
    where: { organizationId: 'zone-001' },
    select: { id: true, name: true, organizationId: true, songIds: true },
    take: 5,
  });
  dbProgs.forEach(p => console.log(p.id, '|', p.name, '| orgId:', p.organizationId, '| songIds:', JSON.stringify(p.songIds)?.slice(0,50)));

  console.log('\nTotal programs in DB with zone-001:', await prisma.program.count({ where: { organizationId: 'zone-001' } }));

  await admin.app().delete();
  await pool.end();
}
main().catch(console.error);
