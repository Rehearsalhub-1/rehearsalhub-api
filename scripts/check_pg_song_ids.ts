import { prisma } from '../src/lib/prisma';

async function main() {
  const sample = await prisma.song.findMany({
    select: { id: true, title: true, createdAt: true },
    orderBy: { id: 'asc' },
    take: 10
  });
  console.log('Sample Postgres Song IDs:');
  for (const r of sample) {
    console.log(r.id, '->', r.title);
  }

  const checkDocIds = ['jucyZ4eGsxd8j1qbHqhw', '33J2MxSJDptLf09Ba4F0', '7qgr1pFPFQtZ3gd2ca2o', '44', '15'];
  const checkRes = await prisma.song.findMany({
    where: { id: { in: checkDocIds } },
    select: { id: true, title: true }
  });
  console.log('\nDirect check for sample IDs in songs table:');
  console.log(checkRes);

  const byTitles = await prisma.song.findMany({
    where: { title: { in: ['My Life is For Your Glory', 'Lord, We Worship You', 'Praise Your Name', 'Receive Life'] } },
    select: { id: true, title: true }
  });
  console.log('\nDirect check by titles:');
  console.log(byTitles);

  await (prisma as any).$disconnect?.();
  process.exit(0);
}

main().catch(console.error);
