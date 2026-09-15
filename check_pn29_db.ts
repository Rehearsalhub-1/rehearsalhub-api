import prisma from './src/lib/prisma';

async function main() {
  // Find the PraiseNight29 program
  const pn29 = await prisma.program.findFirst({
    where: {
      name: { contains: '29', mode: 'insensitive' },
    },
    include: {
      programSongs: {
        include: { song: true },
        orderBy: { order: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!pn29) {
    console.log('No program containing "29" found');
    // list all programs
    const all = await prisma.program.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    console.log('All programs:', all.map(p => ({ id: p.id, name: p.name, category: p.category })));
    return;
  }

  console.log(`Program: ${pn29.name} (${pn29.id})`);
  console.log(`Category: ${pn29.category}`);
  console.log(`Organization: ${pn29.organizationId}`);
  console.log(`programSongs count: ${pn29.programSongs.length}`);
  console.log(`Songs:`);
  pn29.programSongs.forEach((ps, i) => {
    console.log(`  ${i + 1}. [order=${ps.order}] ${ps.song?.title || 'NULL SONG'} (songId=${ps.songId})`);
  });

  // Also check if songs reference this program directly (legacy)
  const directSongs = await prisma.song.findMany({
    where: { praiseNightId: pn29.id } as any,
    select: { id: true, title: true },
  }).catch(() => []);
  console.log(`\nDirect praiseNightId songs: ${directSongs.length}`);
  directSongs.forEach((s, i) => console.log(`  ${i + 1}. ${s.title} (${s.id})`));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
