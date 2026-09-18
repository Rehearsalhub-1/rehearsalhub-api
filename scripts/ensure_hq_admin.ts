import prisma from '../src/lib/prisma';

async function main() {
  const email = 'nnennawealth@gmail.com';

  const matches = await prisma.user.findMany({
    where: {
      OR: [
        { email: { equals: email, mode: 'insensitive' } },
        { email: { contains: 'nnennawealth', mode: 'insensitive' } },
        { firstName: { contains: 'nnenna', mode: 'insensitive' } },
        { lastName: { contains: 'nnenna', mode: 'insensitive' } },
      ],
    },
    include: {
      memberships: {
        include: { organization: true },
      },
    },
  });

  console.log(JSON.stringify({ searchedEmail: email, matchCount: matches.length, matches: matches.map((u) => ({
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role,
    memberships: u.memberships.map((m) => ({
      orgId: m.organizationId,
      orgName: m.organization?.name,
      role: m.role,
      status: m.status,
    })),
  })) }, null, 2));

  if (matches.length === 0) {
    console.log('No user found for nnennawealth@gmail.com.');
    return;
  }

  const targetUser = matches[0];
  const hqOrg = await prisma.organization.findFirst({
    where: {
      OR: [{ id: 'zone-001' }, { isHq: true }],
    },
  });

  const targetOrgId = hqOrg?.id || 'zone-001';
  console.log(`Target HQ org: ${targetOrgId}`);

  const existing = targetUser.memberships.find((m) => m.organizationId === targetOrgId);

  if (existing) {
    await prisma.membership.update({
      where: { id: existing.id },
      data: { role: 'HQ_ADMIN', status: 'ACTIVE' },
    });
    console.log(`Updated membership for ${targetUser.email} in ${targetOrgId} to HQ_ADMIN.`);
  } else {
    await prisma.membership.create({
      data: {
        userId: targetUser.id,
        organizationId: targetOrgId,
        role: 'HQ_ADMIN',
        status: 'ACTIVE',
      },
    });
    console.log(`Created new HQ_ADMIN membership for ${targetUser.email} in ${targetOrgId}.`);
  }

  const updated = await prisma.user.findUnique({
    where: { id: targetUser.id },
    include: { memberships: { include: { organization: true } } },
  });

  console.log(JSON.stringify({
    updatedUser: {
      id: updated?.id,
      email: updated?.email,
      firstName: updated?.firstName,
      lastName: updated?.lastName,
    },
    memberships: updated?.memberships.map((m) => ({
      orgId: m.organizationId,
      orgName: m.organization?.name,
      role: m.role,
      status: m.status,
    })),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
