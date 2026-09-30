import prisma from '../src/lib/prisma';

async function testApi() {
  console.log('=== TESTING WHAT THE APP RECEIVES ===\n');

  // 1. What does GET /programs?category=ministered return?
  const where: any = { category: 'ministered' };
  const ministeredPrograms = await prisma.program.findMany({
    where,
    include: {
      programSongs: {
        include: {
          song: true
        }
      }
    }
  });

  console.log(`Programs with category='ministered': ${ministeredPrograms.length}`);
  for (const p of ministeredPrograms) {
    console.log(`- "${p.name}" (ID: ${p.id}, Songs count: ${p.programSongs.length})`);
  }

  // 2. Check Praise Night 29 specifically
  const pn29 = await prisma.program.findFirst({
    where: { name: { contains: '29', mode: 'insensitive' } },
    include: {
      programSongs: {
        include: {
          song: {
            select: { id: true, title: true, isMaster: true, isMinistered: true }
          }
        }
      }
    }
  });

  if (pn29) {
    console.log(`\nFound Praise Night 29 program: "${pn29.name}" (ID: ${pn29.id}, category: "${pn29.category}", status: "${pn29.status}")`);
    console.log(`Linked songs in junction programSongs: ${pn29.programSongs.length}`);
  }

  // 3. When GET /songs/master is called, what program is linked to Praise Night 29 songs?
  const samplePn29MasterSong = await prisma.song.findFirst({
    where: {
      isMaster: true,
      title: 'SOVEREIGN FOREVER'
    },
    include: {
      programSongs: {
        include: {
          program: { select: { id: true, name: true } }
        }
      }
    }
  });

  console.log('\nSample Song "SOVEREIGN FOREVER" Master Record:');
  console.log(' - ID:', samplePn29MasterSong?.id);
  console.log(' - isMaster:', samplePn29MasterSong?.isMaster);
  console.log(' - programSongs junction:', samplePn29MasterSong?.programSongs);
}

testApi().catch(console.error).finally(() => prisma.$disconnect());
