import prisma from '../src/lib/prisma';

async function run() {
  const songs = await prisma.song.findMany({
    where: { isMaster: true },
    select: { id: true, title: true, createdAt: true, programSongs: { include: { program: true } } },
    orderBy: { createdAt: 'desc' },
    take: 30
  });
  console.log('Top 30 newest master songs:');
  songs.forEach((s, idx) => {
    console.log(`${idx + 1}. "${s.title}" (${s.id}) - CreatedAt: ${s.createdAt?.toISOString()} - Program: ${s.programSongs[0]?.program?.name}`);
  });
}

run().finally(() => prisma.$disconnect());
