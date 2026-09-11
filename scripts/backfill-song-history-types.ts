/**
 * backfill-song-history-types.ts
 *
 * One-time script: reads every song_history row, infers the correct `type`
 * from `newValue` and `description`, writes it back to the DB.
 *
 * Run once after deploy:
 *   npx ts-node -e "require('./scripts/backfill-song-history-types')"
 * Or via Railway one-off command.
 */
import 'dotenv/config';
import prisma from '../src/lib/prisma';

const VALID_TYPES = ['lyrics', 'audio', 'conductor', 'solfa', 'details', 'personnel', 'music-details', 'comments'];

function inferType(
  newValue: string | null,
  description: string | null,
  existingType: string | null,
): string {
  const val  = (newValue    || '').trim();
  const desc = (description || '').toLowerCase();
  const t    = (existingType || '').toLowerCase().trim();

  // Already a known valid type — keep it
  if (VALID_TYPES.includes(t)) return t;

  // Audio: URL pointing to an audio file
  if (
    val.startsWith('http') &&
    (val.includes('.mp3') || val.includes('.wav') || val.includes('.m4a') ||
     val.includes('.ogg') || val.includes('.aac') || val.includes('cloudinary'))
  ) return 'audio';

  // Type keyword hints in stored type or description
  if (t.includes('lyric')     || desc.includes('lyric'))                                 return 'lyrics';
  if (t.includes('audio')     || desc.includes('audio') || desc.includes('recording'))  return 'audio';
  if (t.includes('solfa')     || t.includes('notation')  ||
      desc.includes('solfa')  || desc.includes('notation'))                              return 'solfa';
  if (t.includes('conductor') || t.includes('guide')     ||
      desc.includes('conductor') || desc.includes('arrangement') ||
      desc.includes('guide'))                                                            return 'conductor';
  if (t.includes('personnel') || desc.includes('singer') ||
      desc.includes('drummer') || desc.includes('keyboardist'))                         return 'personnel';
  if (t.includes('music')     || t.includes('key')       || t.includes('tempo') ||
      desc.includes('key change') || desc.includes('tempo') ||
      desc.includes('music detail'))                                                     return 'music-details';
  if (t.includes('comment')   || desc.includes('comment') ||
      desc.includes('coordinator') || desc.includes('pastor') ||
      desc.includes('director'))                                                         return 'comments';

  // Long text with line-breaks or HTML — almost certainly lyrics
  if (val.length > 200 && (val.includes('\n') || val.includes('<p') || val.includes('<div'))) {
    return 'lyrics';
  }

  // JSON object — song-details snapshot
  if (val.startsWith('{')) {
    try { JSON.parse(val); return 'details'; } catch {}
  }

  return 'details'; // safe default
}

async function main() {
  console.log('[backfill] Starting song_history type backfill...');

  const rows = await prisma.songHistory.findMany({
    select: { id: true, type: true, newValue: true, description: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`[backfill] Found ${rows.length} total history rows`);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const correctType = inferType(row.newValue, row.description, row.type);

    // Skip rows that are already correct
    const current = (row.type || '').toLowerCase().trim();
    if (current === correctType) {
      skipped++;
      continue;
    }

    await prisma.songHistory.update({
      where: { id: row.id },
      data: { type: correctType },
    });
    updated++;

    if (updated % 100 === 0) {
      console.log(`[backfill]   ...${updated} rows updated`);
    }
  }

  console.log(`[backfill] Done. Updated: ${updated}, Already correct: ${skipped}`);
}

main()
  .catch((e) => {
    console.error('[backfill] FAILED:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
