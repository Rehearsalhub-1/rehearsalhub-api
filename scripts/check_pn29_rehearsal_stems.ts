import prisma from '../src/lib/prisma';

async function checkPN29Rehearsals() {
  const p = await prisma.program.findUnique({
    where: { id: 'QpZGst03vMkmjEjVzCyG' },
    include: {
      programSongs: {
        include: { song: true },
        orderBy: { order: 'asc' }
      }
    }
  });

  console.log(`Program: "${p?.name}" (${p?.programSongs.length} songs)\n`);
  for (const ps of p?.programSongs || []) {
    const s = ps.song;
    const urls = (s.audioUrls as Record<string, any>) || {};
    const validKeys = Object.keys(urls).filter(k => 
      !k.startsWith('_') && k.toLowerCase() !== 'full' && typeof urls[k] === 'string' && urls[k].trim().length > 0
    );
    if (validKeys.length > 0) {
      console.log(`Order ${ps.order}: "${s.title}" (${s.id}) -> Stems: [${validKeys.join(', ')}]`);
    }
  }
}

checkPN29Rehearsals().finally(() => prisma.$disconnect());
