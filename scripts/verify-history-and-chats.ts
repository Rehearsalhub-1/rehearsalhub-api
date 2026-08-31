import 'dotenv/config';
import prisma from '../src/lib/prisma';

async function verify() {
  console.log('=== Verifying Migrated PostgreSQL Data ===');

  // 1. Song history verification
  const totalHistory = await prisma.songHistory.count();
  console.log(`Total Song History records in DB: ${totalHistory}`);

  const sampleHistory = await prisma.songHistory.findMany({
    take: 3,
    orderBy: { createdAt: 'desc' },
  });
  console.log('Sample Song History records:', JSON.stringify(sampleHistory, null, 2));

  // 2. Chats verification
  const totalChats = await prisma.chat.count();
  const totalMessages = await prisma.message.count();
  console.log(`Total Chats: ${totalChats}`);
  console.log(`Total Messages: ${totalMessages}`);

  const sampleChats = await prisma.chat.findMany({
    take: 3,
    include: {
      participants: true,
      messages: { take: 2 },
    },
  });
  console.log('Sample Chats with Messages:', JSON.stringify(sampleChats, null, 2));

  await prisma.$disconnect();
}

verify().catch(console.error);
