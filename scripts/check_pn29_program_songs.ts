import prisma from '../src/lib/prisma';

async function main() {
  const pn29 = await prisma.program.findFirst({
    where: {
      name: { contains: '29', mode: 'insensitive' }
    },
    include: {
      programSongs: {
        include: {
          song: true
        }
      }
    }
  });

  if (!pn29) {
    console.log('PN29 not found');
    return;
  }

  console.log('PN29 ID:', pn29.id, 'Name:', pn29.name);
  console.log('Songs count:', pn29.programSongs.length);
  for (const ps of pn29.programSongs) {
    const s = ps.song;
    console.log(`- [${ps.order}] ${s.title} (ID: ${s.id}, isMaster: ${s.isMaster})`);
    console.log('  audioUrls keys:', Object.keys(s.audioUrls || {}));
  }
}

main().finally(() => prisma.$disconnect());
