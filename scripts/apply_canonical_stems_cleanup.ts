import prisma from '../src/lib/prisma';
import fs from 'fs';
import path from 'path';

export function classifyStemKey(rawKey: string): string | null {
  const key = rawKey.trim();
  if (!key || key.startsWith('_')) return null;

  const lower = key.toLowerCase();

  // Non-audio or rehearsal notes
  if (
    lower.includes('rehearsal') ||
    lower.includes('correction') ||
    lower.includes('modulation') ||
    lower.includes('chorus & bridge') ||
    lower === 'verse' ||
    lower === 'chorus'
  ) {
    if (!lower.includes('without lead') && !lower.includes('lead &') && !lower.includes('band')) {
      return null;
    }
  }

  // Full Mix
  if (lower === 'full' || lower === 'main' || lower === 'master') {
    return 'full';
  }

  // Soprano
  if (lower.includes('soprano') || lower.includes('sop &') || lower.includes('sop and')) {
    return 'Soprano';
  }

  // Alto
  if (lower.includes('alto')) {
    return 'Alto';
  }

  // Tenor
  if (lower.includes('tenor') || lower.includes('teno ')) {
    return 'Tenor';
  }

  // Bass
  if (lower.includes('bass') && !lower.includes('without')) {
    return 'Bass';
  }

  // Lead vocals (including "BAND & LEAD VOCALS (Without backup vocals)")
  if (
    lower.includes('without backup') ||
    (lower.includes('lead') && !lower.includes('without lead'))
  ) {
    return 'Lead';
  }

  // Backup vocals / BVS (including "BAND & BACK UP VOCALS (Without lead vocals)")
  if (
    lower.includes('without lead') ||
    lower.includes('backup') ||
    lower.includes('back up') ||
    lower.includes('bvs') ||
    lower.includes('backing') ||
    lower.includes('voclas')
  ) {
    return 'Backup Vocals';
  }

  // Band / Instrumental / Drums
  if (
    lower.includes('band') ||
    lower.includes('instrument') ||
    lower.includes('orchesta') ||
    lower.includes('drum')
  ) {
    return 'Band';
  }

  return null;
}

// Preferred ordering of parts
const ROLE_ORDER: Record<string, number> = {
  full: 0,
  Band: 1,
  Lead: 2,
  'Backup Vocals': 3,
  Soprano: 4,
  Alto: 5,
  Tenor: 6,
  Bass: 7,
};

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');
  console.log(`=== CANONICAL STEMS CLEANUP (DRY_RUN = ${DRY_RUN}) ===\n`);

  const songs = await prisma.song.findMany({
    where: { isMaster: true, audioUrls: { not: null as any } },
    select: { id: true, title: true, audioUrls: true },
  });

  console.log(`Found ${songs.length} master songs with audioUrls.`);

  if (!DRY_RUN) {
    const backupFile = path.join(__dirname, 'master_stems_backup_before_canonical_fix.json');
    fs.writeFileSync(backupFile, JSON.stringify(songs, null, 2));
    console.log(`Saved backup of all ${songs.length} master songs to ${backupFile}\n`);
  }

  let updatedCount = 0;
  let totalDuplicatesRemoved = 0;
  const sampleChanges: any[] = [];

  for (const song of songs) {
    const rawUrls = (song.audioUrls as Record<string, any>) || {};
    const metadata: Record<string, any> = {};
    const roleCandidates: Record<string, { key: string; url: string }[]> = {};

    for (const [key, val] of Object.entries(rawUrls)) {
      if (key.startsWith('_')) {
        metadata[key] = val;
        continue;
      }
      if (typeof val !== 'string' || !val.trim()) continue;

      const role = classifyStemKey(key);
      if (!role) continue; // Skip ignored non-stems

      if (!roleCandidates[role]) roleCandidates[role] = [];
      roleCandidates[role].push({ key, url: val.trim() });
    }

    // For each role, pick the best URL
    const canonicalUrls: Record<string, string> = {};
    for (const [role, items] of Object.entries(roleCandidates)) {
      if (items.length === 1) {
        canonicalUrls[role] = items[0].url;
      } else {
        // Multiple candidates for the same role (e.g. BAND and Band)
        // Prefer official rehearsal/railway upload or non-duplicate URL
        items.sort((a, b) => {
          const aPn = a.url.includes('praise_night_29') || a.url.includes('/rehearsals/');
          const bPn = b.url.includes('praise_night_29') || b.url.includes('/rehearsals/');
          if (aPn && !bPn) return -1;
          if (!aPn && bPn) return 1;

          // Prefer standard key name casing
          if (a.key === role && b.key !== role) return -1;
          if (b.key === role && a.key !== role) return 1;

          return 0;
        });

        canonicalUrls[role] = items[0].url;
        totalDuplicatesRemoved += (items.length - 1);
      }
    }

    // Ensure full exists if primary was full
    if (!canonicalUrls.full && rawUrls.full && typeof rawUrls.full === 'string') {
      canonicalUrls.full = rawUrls.full;
    }

    // Reconstruct audioUrls sorted in canonical order
    const newAudioUrls: Record<string, any> = {};
    // Add metadata first
    for (const [k, v] of Object.entries(metadata)) {
      newAudioUrls[k] = v;
    }
    // Add stem parts in canonical order
    const sortedRoles = Object.keys(canonicalUrls).sort((a, b) => (ROLE_ORDER[a] ?? 99) - (ROLE_ORDER[b] ?? 99));
    for (const role of sortedRoles) {
      newAudioUrls[role] = canonicalUrls[role];
    }

    // Check if changed
    const oldNonMetaKeys = Object.keys(rawUrls).filter(k => !k.startsWith('_')).sort();
    const newNonMetaKeys = Object.keys(canonicalUrls).sort();

    const isChanged =
      oldNonMetaKeys.length !== newNonMetaKeys.length ||
      oldNonMetaKeys.some((k, i) => k !== newNonMetaKeys[i] || rawUrls[k] !== newAudioUrls[k]);

    if (isChanged) {
      updatedCount++;
      if (sampleChanges.length < 25) {
        sampleChanges.push({
          title: song.title,
          id: song.id,
          before: oldNonMetaKeys,
          after: sortedRoles,
        });
      }

      if (!DRY_RUN) {
        await prisma.song.update({
          where: { id: song.id },
          data: { audioUrls: newAudioUrls },
        });
      }
    }
  }

  console.log(`\n=== RESULT ===`);
  console.log(`Total songs updated: ${updatedCount}`);
  console.log(`Total duplicate stem tracks collapsed: ${totalDuplicatesRemoved}`);
  console.log(`\nSample changes (first ${sampleChanges.length}):`);
  for (const c of sampleChanges) {
    console.log(`- [${c.title}] (${c.id})`);
    console.log(`   Before: ${c.before.join(', ')}`);
    console.log(`   After:  ${c.after.join(', ')}`);
  }
}

main().finally(async () => {
  const prisma = (await import('../src/lib/prisma')).default;
  await prisma.$disconnect();
});
