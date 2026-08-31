import 'dotenv/config';
import prisma from '../src/lib/prisma';

async function inspect() {
  console.log('--- Inspecting DB with Prisma ---');
  
  // 1. Chat rooms & messages
  const chatCount = await prisma.chat.count();
  const messageCount = await prisma.message.count();
  const sampleChats = await prisma.chat.findMany({
    take: 5,
    include: {
      participants: true,
      messages: { take: 2 },
    },
  });
  console.log(`Chats in DB: ${chatCount}`);
  console.log(`Messages in DB: ${messageCount}`);
  console.log('Sample Chats:', JSON.stringify(sampleChats, null, 2));

  // 2. Subgroups (Churches / Groups)
  const subgroupCount = await prisma.subgroup.count();
  const sampleSubgroups = await prisma.subgroup.findMany({ take: 5 });
  console.log(`Subgroups in DB: ${subgroupCount}`);
  console.log('Sample Subgroups:', JSON.stringify(sampleSubgroups, null, 2));

  // 3. Song History
  const songHistoryCount = await prisma.songHistory.count();
  const sampleSongHistory = await prisma.songHistory.findMany({ take: 5 });
  console.log(`SongHistory entries in DB: ${songHistoryCount}`);
  console.log('Sample SongHistory:', JSON.stringify(sampleSongHistory, null, 2));

  // 4. Check raw_data in songs for embedded history
  const songsWithHistory = await prisma.song.findMany({
    where: {
      rawData: {
        path: ['history'],
        not: null,
      },
    },
    take: 5,
    select: { id: true, title: true, organizationId: true, programId: true, rawData: true },
  });
  console.log(`Songs with embedded rawData.history: ${songsWithHistory.length}`);
  if (songsWithHistory.length > 0) {
    console.log('Sample Song rawData.history:', JSON.stringify(songsWithHistory.map(s => ({
      id: s.id,
      title: s.title,
      orgId: s.organizationId,
      programId: s.programId,
      historySample: (s.rawData as any)?.history?.slice?.(0, 2),
    })), null, 2));
  }

  await prisma.$disconnect();
}

inspect().catch(err => {
  console.error('Inspection error:', err);
  process.exit(1);
});
