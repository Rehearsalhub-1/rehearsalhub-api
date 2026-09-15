import prisma from './src/lib/prisma';

async function main() {
  // Check for HQ-role memberships
  const hqMemberships = await prisma.membership.findMany({
    where: {
      role: { in: ['president', 'PRESIDENT', 'director', 'DIRECTOR', 'oftp', 'OFTP', 'executive', 'EXECUTIVE', 'hq_admin', 'HQ_ADMIN'] }
    },
    include: { user: true, organization: true },
    take: 20
  });

  console.log('=== HQ-Role Memberships ===');
  hqMemberships.forEach(m => {
    console.log({
      userId: m.userId,
      email: m.user?.email,
      role: m.role,
      status: m.status,
      orgId: m.organizationId,
      orgName: (m as any).organization?.name,
    });
  });

  // Also look up by email patterns
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: { contains: 'president', mode: 'insensitive' } },
        { email: { contains: 'director', mode: 'insensitive' } },
        { email: { contains: 'oftp', mode: 'insensitive' } },
      ]
    },
    include: {
      memberships: { take: 5 }
    },
    take: 10
  });

  console.log('\n=== Leadership User Accounts ===');
  users.forEach(u => {
    console.log({
      id: u.id,
      email: u.email,
      name: `${u.firstName} ${u.lastName}`,
      memberships: u.memberships.map(m => ({ role: m.role, status: m.status, orgId: m.organizationId }))
    });
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
