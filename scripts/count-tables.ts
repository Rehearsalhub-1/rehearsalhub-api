import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);

async function main() {
  console.log('\n=== DB Table Counts ===');
  console.log('zones/orgs:  ', await prisma.organization.count());
  console.log('profiles:    ', await prisma.user.count());
  console.log('memberships: ', await prisma.membership.count());
  console.log('songs:       ', await prisma.song.count());
  console.log('programs:    ', await prisma.program.count());
  console.log('attendance:  ', await prisma.attendance.count());
  console.log('categories:  ', await prisma.category.count());
  console.log('submitted:   ', await prisma.submittedSong.count());
  console.log('subgroups:   ', await prisma.subgroup.count());
  console.log('analytics:   ', await prisma.analyticsEvent.count());
  await pool.end();
}

main().catch(console.error);
