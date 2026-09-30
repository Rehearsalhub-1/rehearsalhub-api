import prisma from '../src/lib/prisma';

async function run() {
  const p1 = await prisma.program.findUnique({
    where: { id: 'prog_1790087502159_5kk24' },
    include: { programSongs: { include: { song: true }, orderBy: { order: 'asc' } } }
  });
  console.log(`--- prog_1790087502159_5kk24 (name: "${p1?.name}", category: "${p1?.category}", status: "${p1?.status}") ---`);
  console.log('Count:', p1?.programSongs.length);
  p1?.programSongs.forEach(ps => console.log(ps.order, ps.song.title, `(${ps.song.id})`, 'isMaster:', ps.song.isMaster, 'isMinistered:', ps.song.isMinistered));

  const p2 = await prisma.program.findUnique({
    where: { id: 'QpZGst03vMkmjEjVzCyG' },
    include: { programSongs: { include: { song: true }, orderBy: { order: 'asc' } } }
  });
  console.log(`\n--- QpZGst03vMkmjEjVzCyG (name: "${p2?.name}", category: "${p2?.category}", status: "${p2?.status}") ---`);
  console.log('Count:', p2?.programSongs.length);
  p2?.programSongs.forEach(ps => console.log(ps.order, ps.song.title, `(${ps.song.id})`, 'isMaster:', ps.song.isMaster, 'status:', ps.song.status, 'isMinistered:', ps.song.isMinistered));
}

run().finally(() => prisma.$disconnect());
