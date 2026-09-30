import prisma from '../src/lib/prisma';
import fs from 'fs';
import path from 'path';

// Standard canonical part names (lowercase for matching)
const STANDARD_PARTS = new Set([
  'full', 'band', 'lead', 'tenor', 'alto', 'soprano', 'bass', 'drum',
  'instrumental', 'backup vocals', 'lead vocals', 'bvs',
  'lead & band', 'bvs & band', 'alto & band', 'tenor & band',
  'soprano & band', 'band & backup vocals', 'band & lead vocals',
  'band & backup', 'band & lead',
]);

// Patterns that indicate a singer-name-prefixed entry like "Vashaun (tenor And Band)"
const SINGER_PREFIX_PATTERN = /^[A-Za-z.\s]+(?: ?\()/; // e.g. "Vashaun (", "Ogey (", "Pastor Ruthney("

function isSingerPrefixed(key: string): boolean {
  // Check for patterns like "Name (part)" or "Name(part)"
  const match = key.match(/^(.+?)\s*\((.+)\)$/);
  if (!match) return false;
  const beforeParen = match[1].trim().toLowerCase();
  // If the part before parentheses is NOT a standard part name, it's a singer name
  return !STANDARD_PARTS.has(beforeParen);
}

function isMetadataKey(key: string): boolean {
  return key.startsWith('_');
}

function isEmptyValue(val: any): boolean {
  return val === '' || val === null || val === undefined || val === false;
}

// Score a key name: lower is better (more standard/clean)
function scoreKeyName(key: string): number {
  const lower = key.toLowerCase().trim();
  
  // Metadata keys - always keep, score doesn't matter
  if (isMetadataKey(key)) return -1;
  
  // Exact standard matches are best
  if (STANDARD_PARTS.has(lower)) return 0;
  
  // Singer-prefixed entries are worst
  if (isSingerPrefixed(key)) return 100;
  
  // "X And Band" style (redundant when raw part exists)
  if (/and band/i.test(key)) return 50;
  
  // Other non-standard but not singer-prefixed
  return 25;
}

// Pick the best key name from a group that all point to the same URL
function pickBestKey(keys: string[]): string {
  return keys.sort((a, b) => {
    const scoreA = scoreKeyName(a);
    const scoreB = scoreKeyName(b);
    if (scoreA !== scoreB) return scoreA - scoreB;
    // Prefer shorter names
    return a.length - b.length;
  })[0];
}

async function main() {
  console.log('=== CLEANING UP DUPLICATE STEMS IN MASTER SONGS ===\n');

  // 1. Load all master songs with audioUrls
  const songs = await prisma.song.findMany({
    where: { isMaster: true, audioUrls: { not: null as any } },
    select: { id: true, title: true, audioUrls: true },
  });

  console.log(`Found ${songs.length} master songs with audioUrls.\n`);

  // 2. Save backup
  const backupPath = path.join(__dirname, 'master_stems_backup_pre_cleanup.json');
  fs.writeFileSync(backupPath, JSON.stringify(
    songs.map(s => ({ id: s.id, title: s.title, audioUrls: s.audioUrls })),
    null, 2
  ));
  console.log(`Backup saved to ${backupPath}\n`);

  // 3. Process each song
  let totalCleaned = 0;
  let totalPartsRemoved = 0;
  const updates: { id: string; title: string; before: string[]; after: string[]; removed: string[] }[] = [];

  for (const song of songs) {
    const urls = (song.audioUrls as Record<string, any>) || {};
    const originalKeys = Object.keys(urls);

    // Separate metadata keys from audio part keys
    const metadataEntries: [string, any][] = [];
    const audioEntries: [string, any][] = [];

    for (const [key, val] of Object.entries(urls)) {
      if (isMetadataKey(key)) {
        metadataEntries.push([key, val]);
      } else {
        audioEntries.push([key, val]);
      }
    }

    // Group audio entries by their URL value
    const urlToKeys = new Map<string, string[]>();
    const keyToValue = new Map<string, any>();

    for (const [key, val] of audioEntries) {
      keyToValue.set(key, val);

      if (typeof val !== 'string' || !val.trim()) {
        // Empty values - skip them (will be removed)
        continue;
      }

      const normalizedUrl = val.trim();
      if (!urlToKeys.has(normalizedUrl)) {
        urlToKeys.set(normalizedUrl, []);
      }
      urlToKeys.get(normalizedUrl)!.push(key);
    }

    // For each unique URL, pick the best key name
    const cleanedEntries: [string, string][] = [];
    for (const [url, keys] of urlToKeys) {
      const bestKey = pickBestKey(keys);
      cleanedEntries.push([bestKey, url]);
    }

    // Also add "full" entry from audioEntries if it existed with a valid URL
    // (it might already be in cleanedEntries)

    // Rebuild audioUrls: metadata + cleaned audio entries
    const newUrls: Record<string, any> = {};
    for (const [key, val] of metadataEntries) {
      newUrls[key] = val;
    }
    for (const [key, val] of cleanedEntries) {
      newUrls[key] = val;
    }

    const newKeys = Object.keys(newUrls).filter(k => !isMetadataKey(k));
    const removedKeys = originalKeys.filter(k => !isMetadataKey(k) && !newKeys.includes(k));

    if (removedKeys.length > 0) {
      totalCleaned++;
      totalPartsRemoved += removedKeys.length;
      updates.push({
        id: song.id,
        title: song.title,
        before: originalKeys.filter(k => !isMetadataKey(k)),
        after: newKeys,
        removed: removedKeys,
      });

      // Update in database
      await prisma.song.update({
        where: { id: song.id },
        data: { audioUrls: newUrls },
      });
    }
  }

  // 4. Report
  console.log(`\n=== CLEANUP COMPLETE ===`);
  console.log(`Songs cleaned: ${totalCleaned}`);
  console.log(`Total duplicate/bad parts removed: ${totalPartsRemoved}\n`);

  // Show first 20 examples
  updates.slice(0, 20).forEach((u, i) => {
    console.log(`${i + 1}. [${u.title}] (${u.id})`);
    console.log(`   Before (${u.before.length} parts): ${u.before.join(', ')}`);
    console.log(`   After  (${u.after.length} parts): ${u.after.join(', ')}`);
    console.log(`   Removed: ${u.removed.join(', ')}\n`);
  });

  if (updates.length > 20) {
    console.log(`... and ${updates.length - 20} more songs cleaned.`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
