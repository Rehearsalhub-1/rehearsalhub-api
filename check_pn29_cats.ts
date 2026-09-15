import prisma from './src/lib/prisma';

async function main() {
  const pn29 = await prisma.program.findFirst({
    where: { name: { contains: '29', mode: 'insensitive' } },
    include: {
      programSongs: {
        include: { song: true },
        orderBy: { order: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!pn29) { console.log('Not found'); return; }

  // Tally all categories
  const categoryCounts: Record<string, number> = {};
  pn29.programSongs.forEach((ps) => {
    const s = ps.song as any;
    const cat = s?.category || 'NULL/EMPTY';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });

  console.log(`\nPraiseNight 29: ${pn29.programSongs.length} songs`);
  console.log(`\n--- Category breakdown ---`);
  Object.entries(categoryCounts)
    .sort(([, a], [, b]) => b - a)
    .forEach(([cat, count]) => console.log(`  "${cat}" → ${count} songs`));

  // Also check songCategories relation
  const pn29WithCats = await prisma.program.findFirst({
    where: { id: pn29.id },
    include: {
      programSongs: {
        include: {
          song: {
            include: { songCategories: { include: { category: true } } },
          },
        },
        take: 5,
      },
    },
  });

  console.log(`\n--- First 5 songs with songCategories ---`);
  pn29WithCats?.programSongs?.forEach((ps) => {
    const s = ps.song as any;
    const cats = s?.songCategories?.map((sc: any) => sc?.category?.name || sc?.name) || [];
    console.log(`  ${s?.title}: category="${s?.category}", songCategories=[${cats.join(', ')}]`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
