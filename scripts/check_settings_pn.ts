import prisma from '../src/lib/prisma';

async function check() {
  const s = await prisma.setting.findUnique({ where: { key: 'master_collections_order' } });
  console.log('master_collections_order:', JSON.stringify(s, null, 2));

  // Also check programs
  const programs = await prisma.program.findMany({
    where: { category: 'ministered' },
    select: { id: true, name: true, category: true, isArchived: true, isActive: true, status: true }
  });
  console.log('Ministered programs:', programs.map(p => ({ id: p.id, name: p.name, status: p.status })));
}

check().finally(() => prisma.$disconnect());
