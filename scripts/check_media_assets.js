const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const assets = await prisma.mediaAsset.findMany({
    take: 25,
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, url: true, type: true, folder: true, organizationId: true, createdAt: true }
  });
  console.log('Recent 25 media_assets:');
  console.log(JSON.stringify(assets, null, 2));

  // Also check if any other tables have uploaded files (e.g. chat messages, status, recordings, etc.)
  console.log('\nTotal count of media_assets:', await prisma.mediaAsset.count());
}

main().catch(console.error).finally(() => prisma.$disconnect());
