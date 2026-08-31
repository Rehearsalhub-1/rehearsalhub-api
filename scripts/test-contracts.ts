import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { getMe } from '../src/auth/auth.service';

async function testContracts() {
  console.log('=== 1. Testing getMe contract ===');
  const targetUid = '8ILWjbl9IbgbuxBK9P23mB6pZBt1';
  const me = await getMe(targetUid);
  console.log('getMe output keys:', Object.keys(me));
  console.log('getMe permissions & flags:', {
    hasHqAccess: me.hasHqAccess,
    canAccessArchive: me.canAccessArchive,
    canAccessPreRehearsal: me.canAccessPreRehearsal,
    canAnnotate: me.canAnnotate,
    hiddenFeatures: me.hiddenFeatures,
  });

  console.log('\n=== 2. Testing Chat Participant & Group Contracts ===');
  const userChats = await prisma.chatParticipant.findMany({
    where: { userId: targetUid },
    include: {
      chat: {
        include: {
          participants: true,
        },
      },
    },
  });
  console.log(`User is in ${userChats.length} chats in database.`);
  userChats.forEach(uc => {
    console.log(`- Chat: id="${uc.chatId}", type="${uc.chat.type}", name="${(uc.chat.rawData as any)?.name}", participants=${uc.chat.participants.length}`);
  });

  console.log('\n=== 3. Testing Song and Program Counts ===');
  const songsCount = await prisma.song.count();
  const programsCount = await prisma.program.count();
  const messagesCount = await prisma.message.count();
  console.log(`Songs: ${songsCount}, Programs: ${programsCount}, Messages: ${messagesCount}`);

  await prisma.$disconnect();
}

testContracts().catch(console.error);
