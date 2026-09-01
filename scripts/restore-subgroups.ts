import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);

async function main() {
  console.log('Restoring subgroups from backup...');
  const backupFile = path.join(__dirname, '..', 'backups', 'subgroups_legacy_backup_1788190053987.json');
  const raw = fs.readFileSync(backupFile, 'utf-8');
  const subgroups = JSON.parse(raw);

  let restored = 0;
  for (const sg of subgroups) {
    await prisma.subgroup.upsert({
      where: { id: sg.id },
      create: {
        id: sg.id,
        organizationId: sg.organizationId,
        name: sg.name,
        description: sg.description,
        type: sg.type || 'church',
        status: sg.status || 'active',
        estimatedMembers: sg.estimatedMembers,
        createdAt: sg.createdAt ? new Date(sg.createdAt) : new Date(),
        updatedAt: sg.updatedAt ? new Date(sg.updatedAt) : new Date(),
        rawData: sg.rawData,
      },
      update: {
        organizationId: sg.organizationId,
        name: sg.name,
        description: sg.description,
        type: sg.type || 'church',
        status: sg.status || 'active',
        estimatedMembers: sg.estimatedMembers,
        rawData: sg.rawData,
      },
    });
    restored++;
  }

  console.log(`✓ Restored ${restored} subgroups successfully.`);
  console.log('Subgroup count now:', await prisma.subgroup.count());
  await pool.end();
}

main().catch(console.error);
