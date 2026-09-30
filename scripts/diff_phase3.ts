import prisma from '../src/lib/prisma';
import fs from 'fs';

async function diff() {
  const backup: any[] = JSON.parse(fs.readFileSync('scripts/master_stems_backup_phase3.json', 'utf8'));
  const backupMap = new Map<string, any>();
  backup.forEach(s => backupMap.set(s.id, s));

  const currentSongs = await prisma.song.findMany({
    where: { isMaster: true },
    select: { id: true, title: true, audioUrls: true }
  });

  const changedSongs: any[] = [];
  for (const curr of currentSongs) {
    const prev = backupMap.get(curr.id);
    if (!prev) continue;
    const prevUrls = JSON.stringify(prev.audioUrls || {});
    const currUrls = JSON.stringify(curr.audioUrls || {});
    if (prevUrls !== currUrls) {
      changedSongs.push({
        id: curr.id,
        title: curr.title,
        before: prev.audioUrls,
        after: curr.audioUrls
      });
    }
  }

  console.log(`Total master songs changed in Phase 3: ${changedSongs.length}`);
  changedSongs.slice(0, 15).forEach((c, i) => {
    console.log(`\n${i + 1}. [${c.title}] (${c.id})`);
    console.log('  BEFORE parts:', Object.keys(c.before || {}));
    console.log('  AFTER parts:', Object.keys(c.after || {}));
    // Check if new parts were added
    const beforeKeys = new Set(Object.keys(c.before || {}));
    const addedKeys = Object.keys(c.after || {}).filter(k => !beforeKeys.has(k));
    console.log('  ADDED parts:', addedKeys);
    addedKeys.forEach(k => {
      console.log(`    - ${k}: ${String(c.after[k]).slice(-50)}`);
    });
  });
}

diff().finally(() => prisma.$disconnect());
