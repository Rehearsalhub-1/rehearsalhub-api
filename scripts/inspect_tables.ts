import prisma from '../src/lib/prisma';

async function listAllTables() {
  const tables: any[] = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
  );
  console.log('PUBLIC TABLES:', tables.map(t => t.table_name));
  
  for (const t of ['attendance', 'admin_requests', 'submitted_songs', 'media_doodles', 'user_song_notes', 'support_tickets', 'individual_subscriptions']) {
    const cols: any[] = await prisma.$queryRawUnsafe(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      t
    );
    console.log(`COLUMNS FOR ${t}:`, cols);
  }
  await prisma.$disconnect();
}

listAllTables().catch(console.error);
