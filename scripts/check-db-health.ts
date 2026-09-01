import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   RAILWAY POSTGRESQL DATABASE HEALTH AUDIT                 ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const [
    orgCount,
    profileCount,
    membershipCount,
    masterSongCount,
    customSongCount,
    programCount,
    programSongCount,
    mediaCount,
    chatCount,
    chatParticipantCount,
    messageCount,
    notificationCount,
    attendanceCount,
    playlistCount,
    playlistItemCount,
  ] = await Promise.all([
    prisma.organization.count(),
    prisma.user.count(),
    prisma.membership.count(),
    prisma.song.count({ where: { isMaster: true } }),
    prisma.song.count({ where: { isMaster: false } }),
    prisma.program.count(),
    prisma.programSong.count(),
    prisma.mediaAsset.count(),
    prisma.chat.count(),
    prisma.chatParticipant.count(),
    prisma.message.count(),
    prisma.notification.count(),
    prisma.attendance.count(),
    prisma.playlist.count(),
    prisma.playlistItem.count(),
  ]);

  console.log('── Database Counts ─────────────────────────────────────────');
  console.table({
    'Organizations': orgCount,
    'Profiles (Singers/Admins)': profileCount,
    'Memberships (Role Mappings)': membershipCount,
    'Public Master Songs (Global Repertoire)': masterSongCount,
    'Program / Custom Songs': customSongCount,
    'Total Songs': masterSongCount + customSongCount,
    'Programs / Rehearsals': programCount,
    'Program-Song Junction Links': programSongCount,
    'Media Assets (with URLs)': mediaCount,
    'Chat Channels': chatCount,
    'Chat Participants Wired': chatParticipantCount,
    'Chat Messages': messageCount,
    'Notifications': notificationCount,
    'Attendance Records': attendanceCount,
    'User Playlists': playlistCount,
    'Playlist Items': playlistItemCount,
  });

  // Sample check: Verify a user and their membership
  const sampleUsers = await prisma.user.findMany({
    take: 5,
    include: { memberships: { include: { organization: true } } },
  });

  console.log('\n── Sample User Memberships ─────────────────────────────────');
  for (const u of sampleUsers) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'User';
    console.log(`User: ${u.email || u.id} (${name})`);
    for (const m of u.memberships) {
      console.log(`  └─ Org: ${m.organization.name} [${m.organizationId}] | Role: ${m.role}`);
    }
  }

  // Sample check: Verify Master Songs
  const sampleSongs = await prisma.song.findMany({
    take: 3,
    where: { isMaster: true },
    select: { id: true, title: true, key: true, leadSinger: true, writer: true, audioFile: true },
  });
  console.log('\n── Sample Master Songs ─────────────────────────────────────');
  console.table(sampleSongs);

  await pool.end();
}

main().catch(console.error);
