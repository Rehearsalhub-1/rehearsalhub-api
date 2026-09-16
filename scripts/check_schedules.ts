import prisma from '../src/lib/prisma';

async function main() {
  const settings = await prisma.$queryRawUnsafe(`
    SELECT id, key FROM settings;
  `).catch(e => ({ error: (e as any).message }));
  console.log('Settings keys:', JSON.stringify(settings, null, 2));

  const programs = await prisma.program.findMany({
    select: {
      id: true,
      name: true,
      category: true,
      status: true,
      organizationId: true,
      groupId: true,
      isActive: true,
      isArchived: true,
    },
  });
  console.log('Programs count:', programs.length);
  console.log('Programs sample:', JSON.stringify(programs.slice(0, 5), null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
