import prisma from './src/lib/prisma';

async function main() {
  const songs = await prisma.song.findMany({
    where: { title: { contains: 'receive life', mode: 'insensitive' } },
    select: { id: true, title: true, isMaster: true }
  });

  console.log('Songs found:', songs.length);

  for (const s of songs) {
    console.log(`\nSong: "${s.title}" | id: ${s.id} | isMaster: ${s.isMaster}`);

    const history = await prisma.songHistory.findMany({
      where: { songId: s.id },
      orderBy: { createdAt: 'desc' },
      take: 30
    });

    console.log(`  song_history records: ${history.length}`);
    for (const h of history) {
      console.log(`  - type: "${h.type}" | desc: "${(h.description || '').substring(0, 60)}" | newValue_len: ${(h.newValue || '').length}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
