import prisma from '../src/lib/prisma';

async function check() {
  // Get all PN29 master songs
  const pn29 = await prisma.program.findUnique({
    where: { id: 'prog_1790087502159_5kk24' },
    include: {
      programSongs: {
        include: { song: { select: { id: true, title: true, audioUrls: true, audioFile: true } } },
        orderBy: { order: 'asc' }
      }
    }
  });

  console.log(`PRAISE NIGHT 29 master songs (${pn29?.programSongs.length}):\n`);
  
  for (const ps of pn29?.programSongs || []) {
    const s = ps.song;
    const urls = (s.audioUrls as Record<string, any>) || {};
    const allKeys = Object.keys(urls).filter(k => !k.startsWith('_'));
    const stemsOnly = allKeys.filter(k => k.toLowerCase() !== 'full');
    const hasFull = urls.full ? '✅ has full' : '❌ no full';
    
    console.log(`"${s.title}" (${s.id})`);
    console.log(`  ${hasFull} | audioFile: ${s.audioFile ? 'YES' : 'NO'}`);
    console.log(`  All parts: [${allKeys.join(', ')}]`);
    console.log(`  Stems (non-full): [${stemsOnly.join(', ')}]`);
    
    // Show which have actual URLs vs empty
    stemsOnly.forEach(k => {
      const val = urls[k];
      const hasUrl = typeof val === 'string' && val.trim().startsWith('http');
      console.log(`    - ${k}: ${hasUrl ? '✅ has audio' : '❌ EMPTY'}`);
    });
    console.log('');
  }
}

check().finally(() => prisma.$disconnect());
