import prisma from '../src/lib/prisma';

async function inspect() {
  const songs = await prisma.song.findMany({
    where: { isMaster: true, audioUrls: { not: null as any } },
    select: { id: true, title: true, audioUrls: true }
  });
  console.log('Total master songs with audioUrls:', songs.length);
  
  let countMany = 0;
  for (const s of songs) {
    const urls = (s.audioUrls as Record<string, any>) || {};
    // real audio stem parts (skip metadata keys and empty strings)
    const validEntries = Object.entries(urls).filter(([k, v]) => 
      !k.startsWith('_') && k.toLowerCase() !== 'full' && typeof v === 'string' && v.trim().startsWith('http')
    );

    // Let's check if the URLs contain filename matching this song or someone else's song!
    const mismatchedParts: string[] = [];
    const normTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const [k, v] of validEntries) {
      const urlStr = v.toLowerCase();
      // check filename at end of url
      const filename = urlStr.split('/').pop() || '';
      // If filename has words that don't match the song title
      // let's see
    }

    if (validEntries.length > 0) {
      countMany++;
      if (countMany <= 25) {
        console.log(`\n[${s.title}] (${s.id}) - ${validEntries.length} valid stems:`);
        validEntries.forEach(([k, v]) => {
          const fn = v.split('/').pop();
          console.log(`  - Part: "${k}" -> File: ${fn}`);
        });
      }
    }
  }
}

inspect().finally(() => prisma.$disconnect());
