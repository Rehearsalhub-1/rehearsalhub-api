import { prisma } from './src/lib/prisma';

async function main() {
  const songs = await prisma.song.findMany({
    where: { status: 'live' },
    include: {
      programSongs: { include: { program: true } }
    }
  });
  console.log("LIVE SONGS WITH PROGRAMS:", JSON.stringify(songs, null, 2));

  const programs = await prisma.program.findMany({
    select: { id: true, name: true, status: true, isActive: true, date: true, updatedAt: true }
  });
  console.log("ALL PROGRAMS:", JSON.stringify(programs, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
