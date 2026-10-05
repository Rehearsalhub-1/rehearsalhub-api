/**
 * audit_railway_urls.ts
 *
 * READ-ONLY audit script.
 * Scans all DB tables that store media URLs and counts how many
 * are Railway proxy URLs (upload/file) vs Cloudinary vs direct R2 vs other.
 *
 * Run with:
 *   npx tsx scripts/audit_railway_urls.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || process.env.DATABASE_DIRECT_URL,
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

const RAILWAY_PREFIX = 'rehearsalhub-api-production-6a17.up.railway.app/upload/file';
const R2_PREFIX = 'pub-cb7697578fcc48d3b3aeb70a47eb2f65.r2.dev';
const CLOUDINARY_PREFIX = 'res.cloudinary.com';

function classify(url: string | null | undefined): 'railway' | 'cloudinary' | 'r2_direct' | 'other' | 'empty' {
  if (!url || url.trim() === '') return 'empty';
  const u = url.trim();
  if (u.includes(RAILWAY_PREFIX) || u.includes('/upload/file/')) return 'railway';
  if (u.includes(CLOUDINARY_PREFIX)) return 'cloudinary';
  if (u.includes(R2_PREFIX)) return 'r2_direct';
  return 'other';
}

interface TableReport {
  table: string;
  column: string;
  total: number;
  railway: number;
  cloudinary: number;
  r2_direct: number;
  other: number;
  empty: number;
  railwaySamples: string[];
}

async function auditColumn(
  table: string,
  column: string,
  rows: Array<{ id: string; value: string | null }>
): Promise<TableReport> {
  const counts = { railway: 0, cloudinary: 0, r2_direct: 0, other: 0, empty: 0 };
  const railwaySamples: string[] = [];

  for (const row of rows) {
    const kind = classify(row.value);
    counts[kind]++;
    if (kind === 'railway' && railwaySamples.length < 3) {
      railwaySamples.push(`  [${row.id}] ${row.value}`);
    }
  }

  return { table, column, total: rows.length, ...counts, railwaySamples };
}

async function main() {
  console.log('='.repeat(70));
  console.log('  RAILWAY URL AUDIT — RehearsalHub DB');
  console.log('  Cloudinary URLs are NOT touched (manual process)');
  console.log('='.repeat(70));
  console.log();

  const reports: TableReport[] = [];

  // 1. songs.audio_file
  const songs_audioFile = await prisma.song.findMany({
    where: { audioFile: { not: null } },
    select: { id: true, audioFile: true },
  });
  reports.push(await auditColumn('songs', 'audio_file',
    songs_audioFile.map(r => ({ id: r.id, value: r.audioFile }))));

  // 2. songs.audio_urls (JSON — may contain many URLs per song)
  const songs_audioUrls = await prisma.song.findMany({
    where: { audioUrls: { not: null } },
    select: { id: true, audioUrls: true },
  });

  let jsonRailway = 0, jsonCloudinary = 0, jsonR2 = 0, jsonOther = 0, jsonTotal = 0;
  const jsonSamples: string[] = [];

  for (const song of songs_audioUrls) {
    if (!song.audioUrls || typeof song.audioUrls !== 'object') continue;
    for (const url of Object.values(song.audioUrls as Record<string, any>)) {
      if (typeof url !== 'string') continue;
      jsonTotal++;
      const kind = classify(url);
      if (kind === 'railway') { jsonRailway++; if (jsonSamples.length < 3) jsonSamples.push(`  [${song.id}] ${url}`); }
      else if (kind === 'cloudinary') jsonCloudinary++;
      else if (kind === 'r2_direct') jsonR2++;
      else jsonOther++;
    }
  }
  reports.push({ table: 'songs', column: 'audio_urls (JSON stems)', total: jsonTotal, railway: jsonRailway, cloudinary: jsonCloudinary, r2_direct: jsonR2, other: jsonOther, empty: 0, railwaySamples: jsonSamples });

  // 3. profiles.avatar_url
  const profiles = await prisma.user.findMany({
    where: { avatarUrl: { not: null } },
    select: { id: true, avatarUrl: true },
  });
  reports.push(await auditColumn('profiles', 'avatar_url', profiles.map(r => ({ id: r.id, value: r.avatarUrl }))));

  // 4. programs.banner_image
  const programs = await prisma.program.findMany({
    where: { bannerImage: { not: null } },
    select: { id: true, bannerImage: true },
  });
  reports.push(await auditColumn('programs', 'banner_image', programs.map(r => ({ id: r.id, value: r.bannerImage }))));

  // 5. categories.image
  const categories = await prisma.category.findMany({
    where: { image: { not: null } },
    select: { id: true, image: true },
  });
  reports.push(await auditColumn('categories', 'image', categories.map(r => ({ id: r.id, value: r.image }))));

  // 6. media_assets.url
  const mediaUrl = await prisma.mediaAsset.findMany({ select: { id: true, url: true } });
  reports.push(await auditColumn('media_assets', 'url', mediaUrl.map(r => ({ id: r.id, value: r.url }))));

  // 7. media_assets.thumbnail
  const mediaThumb = await prisma.mediaAsset.findMany({
    where: { thumbnail: { not: null } },
    select: { id: true, thumbnail: true },
  });
  reports.push(await auditColumn('media_assets', 'thumbnail', mediaThumb.map(r => ({ id: r.id, value: r.thumbnail }))));

  // 8. submitted_songs.audio_url
  const submitted = await prisma.submittedSong.findMany({
    where: { audioUrl: { not: null } },
    select: { id: true, audioUrl: true },
  });
  reports.push(await auditColumn('submitted_songs', 'audio_url', submitted.map(r => ({ id: r.id, value: r.audioUrl }))));

  // 9. user_statuses.media_url
  const statuses = await prisma.userStatus.findMany({ select: { id: true, mediaUrl: true } });
  reports.push(await auditColumn('user_statuses', 'media_url', statuses.map(r => ({ id: r.id, value: r.mediaUrl }))));

  // 10. calls.caller_avatar
  const calls = await prisma.call.findMany({
    where: { callerAvatar: { not: null } },
    select: { id: true, callerAvatar: true },
  });
  reports.push(await auditColumn('calls', 'caller_avatar', calls.map(r => ({ id: r.id, value: r.callerAvatar }))));

  // ── Print Results ────────────────────────────────────────────────────────
  let grandRailway = 0, grandCloudinary = 0, grandR2 = 0;

  for (const r of reports) {
    grandRailway += r.railway;
    grandCloudinary += r.cloudinary;
    grandR2 += r.r2_direct;

    const marker = r.railway > 0 ? '⚠️ ' : '✅ ';
    console.log(`${marker}[${r.table}] → ${r.column}`);
    console.log(`   Total URLs  : ${r.total}`);
    console.log(`   🔴 Railway  : ${r.railway}  ← needs migration`);
    console.log(`   🟡 Cloudinary: ${r.cloudinary}  ← skip (manual)`);
    console.log(`   🟢 R2 direct: ${r.r2_direct}`);
    console.log(`   ⚪ Other    : ${r.other}`);
    if (r.railwaySamples.length > 0) {
      console.log(`   Sample Railway URLs:`);
      r.railwaySamples.forEach(s => console.log(s));
    }
    console.log();
  }

  console.log('='.repeat(70));
  console.log('  GRAND TOTAL SUMMARY');
  console.log(`  🔴 Railway URLs to migrate  : ${grandRailway}`);
  console.log(`  🟡 Cloudinary (skip/manual) : ${grandCloudinary}`);
  console.log(`  🟢 Already direct R2        : ${grandR2}`);
  console.log('='.repeat(70));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
