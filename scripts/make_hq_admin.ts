import prisma from '../src/lib/prisma';

async function main() {
  console.log('Searching for account styleirech@gmial.com / admin admin...');

  // Search by exact email, variations, or name
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: 'styleirech@gmial.com', mode: 'insensitive' } },
        { email: { equals: 'styleirech@gmail.com', mode: 'insensitive' } },
        { email: { contains: 'styleirech', mode: 'insensitive' } },
        {
          AND: [
            { firstName: { equals: 'admin', mode: 'insensitive' } },
            { lastName: { equals: 'admin', mode: 'insensitive' } },
          ],
        },
      ],
    },
    include: {
      memberships: {
        include: { organization: true },
      },
    },
  });

  if (!user) {
    console.log('Searching all users for any email containing "style"...');
    const candidates = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: 'style', mode: 'insensitive' } },
          { email: { contains: 'gmial', mode: 'insensitive' } },
          { firstName: { equals: 'admin', mode: 'insensitive' } },
        ],
      },
      include: { memberships: true },
      take: 20,
    });
    console.log('Found candidates:', candidates.map(c => ({ id: c.id, email: c.email, name: `${c.firstName} ${c.lastName}` })));
    if (candidates.length > 0) {
      user = candidates[0];
    }
  }

  if (!user) {
    console.error('Could not find user styleirech@gmial.com or admin admin.');
    return;
  }

  console.log(`\nFound target user: ${user.id} (${user.email}) - ${user.firstName} ${user.lastName}`);
  console.log('Current memberships:', user.memberships.map(m => ({ id: m.id, orgId: m.organizationId, role: m.role, status: m.status })));

  // Target HQ Organization
  const hqOrg = await prisma.organization.findFirst({
    where: {
      OR: [
        { id: 'zone-001' },
        { isHq: true },
      ],
    },
  });

  const targetOrgId = hqOrg?.id || 'zone-001';
  console.log(`\nTarget HQ Organization ID: ${targetOrgId}`);

  // Upsert or update membership
  const existingMem = user.memberships.find(m => m.organizationId === targetOrgId);
  if (existingMem) {
    console.log(`Updating existing membership ${existingMem.id} in ${targetOrgId} to role 'HQ_ADMIN'...`);
    await prisma.membership.update({
      where: { id: existingMem.id },
      data: {
        role: 'HQ_ADMIN',
        status: 'ACTIVE',
      },
    });
  } else {
    console.log(`Creating new HQ_ADMIN membership in ${targetOrgId}...`);
    await prisma.membership.create({
      data: {
        userId: user.id,
        organizationId: targetOrgId,
        role: 'HQ_ADMIN',
        status: 'ACTIVE',
      },
    });
  }

  // Also verify user profile itself
  const updatedUser = await prisma.user.findUnique({
    where: { id: user.id },
    include: { memberships: true },
  });

  console.log(`\nSUCCESS: User "${updatedUser?.email}" (${updatedUser?.firstName} ${updatedUser?.lastName}) is now an active HQ_ADMIN!`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
