const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const songs = await prisma.song.findMany({
    where: { status: 'live' },
    select: { id: true, title: true, status: true, updatedAt: true, organizationId: true }
  });
  console.log("LIVE SONGS IN DB:", songs.length);
  console.log(JSON.stringify(songs, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
