/**
 * ============================================================================
 * Cloudinary → R2 Mass Migration Script
 * Run via: npx tsx scripts/migrate-cloudinary-to-r2.ts
 * Or via GitHub Actions: .github/workflows/migrate-cloudinary-to-r2.yml
 * ============================================================================
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/lib/prisma';
import { uploadToR2 } from '../src/services/r2Service';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

const DRY_RUN = process.env.DRY_RUN === 'true';
const DEFAULT_HQ_ZONE = 'zone-001';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isCloudinaryUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  return url.includes('cloudinary.com') || url.includes('res.cloudinary.com');
}

function getExtensionFromUrl(url: string, fallback = 'mp3'): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace('.', '');
    return ext || fallback;
  } catch {
    return fallback;
  }
}

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    webm: 'audio/webm',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

function downloadFile(url: string, maxRedirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects'));
    }

    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RehearsalHubMediaMigrator/1.0)',
        },
        timeout: 60000,
      },
      (res) => {
        if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
          const loc = res.headers.location;
          if (loc) {
            const redirectUrl = loc.startsWith('http') ? loc : new URL(loc, url).toString();
            return downloadFile(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
          }
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timeout (60s)'));
    });
  });
}

// ── CSV Output ────────────────────────────────────────────────────────────────

const OUT_DIR = path.join(__dirname);
const CSV_PATH = path.join(OUT_DIR, 'cloudinary-migration-map.csv');
const FAILED_PATH = path.join(OUT_DIR, 'cloudinary-migration-failed.csv');

function initCsv() {
  fs.writeFileSync(CSV_PATH, 'id,title,zoneId,category,field,stemKey,oldUrl,newR2Url\n');
  fs.writeFileSync(FAILED_PATH, 'id,title,zoneId,category,field,stemKey,oldUrl,error\n');
}

const q = (s: string) => `"${(s || '').replace(/"/g, "'")}"`;

function appendSuccess(r: {
  id: string;
  title: string;
  zoneId: string;
  category: string;
  field: string;
  stemKey: string;
  oldUrl: string;
  newR2Url: string;
}) {
  fs.appendFileSync(
    CSV_PATH,
    [r.id, q(r.title), r.zoneId, r.category, r.field, r.stemKey, r.oldUrl, r.newR2Url].join(',') + '\n'
  );
}

function appendFailed(r: {
  id: string;
  title: string;
  zoneId: string;
  category: string;
  field: string;
  stemKey: string;
  oldUrl: string;
  error: string;
}) {
  fs.appendFileSync(
    FAILED_PATH,
    [r.id, q(r.title), r.zoneId, r.category, r.field, r.stemKey, r.oldUrl, q(r.error)].join(',') + '\n'
  );
}

// ── Core Migration Unit ───────────────────────────────────────────────────────

async function migrateItem(opts: {
  id: string;
  title: string;
  zoneId: string;
  category: string; // 'songs' | 'media' | 'videos'
  field: string;
  stemKey: string;
  url: string;
  defaultExt?: string;
}): Promise<boolean> {
  const { id, title, zoneId, category, field, stemKey, url, defaultExt = 'mp3' } = opts;

  if (!isCloudinaryUrl(url)) {
    console.log(`    ⏭  SKIP (not Cloudinary): [${category}] ${field}/${stemKey}`);
    return true;
  }

  const folder = `zones/${zoneId}/${category}`;

  if (DRY_RUN) {
    console.log(`    🔍 DRY RUN: would migrate ${field}/${stemKey} → ${folder}/`);
    appendSuccess({ id, title, zoneId, category, field, stemKey, oldUrl: url, newR2Url: 'DRY_RUN' });
    return true;
  }

  try {
    console.log(`    ⬇  Download: ${url.slice(0, 90)}...`);
    const buffer = await downloadFile(url);
    const ext = getExtensionFromUrl(url, defaultExt);
    const filename = `${id}_${field}_${stemKey}.${ext}`;

    console.log(`    ⬆  Upload to R2: ${folder}/${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    const result = await uploadToR2(buffer, {
      folder,
      filename,
      contentType: getMimeType(ext),
    });

    appendSuccess({ id, title, zoneId, category, field, stemKey, oldUrl: url, newR2Url: result.url });
    console.log(`    ✅ ${result.url}`);
    return true;
  } catch (err: any) {
    const error = err?.message || String(err);
    console.error(`    ❌ FAILED: ${error}`);
    appendFailed({ id, title, zoneId, category, field, stemKey, oldUrl: url, error });
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🚀 Cloudinary → R2 Mass Migration Started ${DRY_RUN ? '[DRY RUN]' : ''}\n`);
  initCsv();

  let totalOk = 0;
  let totalFail = 0;

  // 1. Songs table (audioFile and stem audioUrls)
  console.log('────────────────────────────────────────────────────────────');
  console.log('📦 1/3 Inspecting SONGS table...');
  const songs = await prisma.song.findMany({
    select: { id: true, title: true, organizationId: true, audioFile: true, audioUrls: true },
  });

  const songTargets = songs.filter(
    (s) =>
      isCloudinaryUrl(s.audioFile) ||
      (s.audioUrls &&
        typeof s.audioUrls === 'object' &&
        Object.values(s.audioUrls as Record<string, string>).some(isCloudinaryUrl))
  );

  console.log(`   Total songs:              ${songs.length}`);
  console.log(`   Songs with Cloudinary:    ${songTargets.length}\n`);

  for (let i = 0; i < songTargets.length; i++) {
    const song = songTargets[i];
    const zoneId = song.organizationId || DEFAULT_HQ_ZONE;
    console.log(`[Song ${i + 1}/${songTargets.length}] 🎵 "${song.title}" (Zone: ${zoneId})`);

    // Main mix
    if (isCloudinaryUrl(song.audioFile)) {
      const r = await migrateItem({
        id: song.id,
        title: song.title,
        zoneId,
        category: 'songs',
        field: 'audioFile',
        stemKey: 'full',
        url: song.audioFile!,
        defaultExt: 'mp3',
      });
      r ? totalOk++ : totalFail++;
    }

    // Stems
    if (song.audioUrls && typeof song.audioUrls === 'object') {
      for (const [stemKey, stemUrl] of Object.entries(song.audioUrls as Record<string, string>)) {
        if (!isCloudinaryUrl(stemUrl)) continue;
        const r = await migrateItem({
          id: song.id,
          title: song.title,
          zoneId,
          category: 'songs',
          field: 'audioUrls',
          stemKey,
          url: stemUrl,
          defaultExt: 'mp3',
        });
        r ? totalOk++ : totalFail++;
      }
    }

    if (!DRY_RUN) await new Promise((r) => setTimeout(r, 250));
  }

  // 2. MediaAssets table (media library)
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('📦 2/3 Inspecting MEDIA ASSETS (media library)...');
  try {
    const mediaAssets = await prisma.mediaAsset.findMany({
      select: { id: true, title: true, organizationId: true, url: true, thumbnail: true, type: true },
    });

    const mediaTargets = mediaAssets.filter(
      (m) => isCloudinaryUrl(m.url) || isCloudinaryUrl(m.thumbnail)
    );

    console.log(`   Total media assets:       ${mediaAssets.length}`);
    console.log(`   Media with Cloudinary:    ${mediaTargets.length}\n`);

    for (let i = 0; i < mediaTargets.length; i++) {
      const m = mediaTargets[i];
      const zoneId = m.organizationId || DEFAULT_HQ_ZONE;
      const isVideo = (m.type || '').toLowerCase() === 'video';
      const defExt = isVideo ? 'mp4' : 'mp3';
      console.log(`[Media ${i + 1}/${mediaTargets.length}] 🎬 "${m.title}" (Zone: ${zoneId})`);

      if (isCloudinaryUrl(m.url)) {
        const r = await migrateItem({
          id: m.id,
          title: m.title,
          zoneId,
          category: isVideo ? 'videos' : 'media',
          field: 'url',
          stemKey: 'main',
          url: m.url,
          defaultExt: defExt,
        });
        r ? totalOk++ : totalFail++;
      }

      if (isCloudinaryUrl(m.thumbnail)) {
        const r = await migrateItem({
          id: m.id,
          title: `${m.title} (thumbnail)`,
          zoneId,
          category: 'media',
          field: 'thumbnail',
          stemKey: 'thumb',
          url: m.thumbnail!,
          defaultExt: 'jpg',
        });
        r ? totalOk++ : totalFail++;
      }

      if (!DRY_RUN) await new Promise((r) => setTimeout(r, 250));
    }
  } catch (err: any) {
    console.warn('   ⚠️  Notice: MediaAsset query skipped:', err?.message || err);
  }

  // 3. Raw media_videos table (if present in PostgreSQL)
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('📦 3/3 Inspecting MEDIA_VIDEOS table...');
  try {
    const videoRows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, title, video_url, thumbnail, raw_data FROM media_videos LIMIT 1000`
    );

    if (Array.isArray(videoRows)) {
      const videoTargets = videoRows.filter((v) => {
        const raw = v.raw_data && typeof v.raw_data === 'object' ? v.raw_data : {};
        const url = v.video_url || v.url || raw.videoUrl || raw.url || raw.mediaUrl;
        const thumb = v.thumbnail || raw.thumbnail || raw.thumbnailUrl || raw.imageUrl;
        return isCloudinaryUrl(url) || isCloudinaryUrl(thumb);
      });

      console.log(`   Total videos:             ${videoRows.length}`);
      console.log(`   Videos with Cloudinary:   ${videoTargets.length}\n`);

      for (let i = 0; i < videoTargets.length; i++) {
        const v = videoTargets[i];
        const raw = v.raw_data && typeof v.raw_data === 'object' ? v.raw_data : {};
        const url = v.video_url || v.url || raw.videoUrl || raw.url || raw.mediaUrl;
        const thumb = v.thumbnail || raw.thumbnail || raw.thumbnailUrl || raw.imageUrl;
        const title = v.title || raw.title || raw.name || `Video_${v.id}`;
        const zoneId = DEFAULT_HQ_ZONE;

        console.log(`[Video ${i + 1}/${videoTargets.length}] 📹 "${title}" (Zone: ${zoneId})`);

        if (isCloudinaryUrl(url)) {
          const r = await migrateItem({
            id: String(v.id),
            title,
            zoneId,
            category: 'videos',
            field: 'video_url',
            stemKey: 'video',
            url,
            defaultExt: 'mp4',
          });
          r ? totalOk++ : totalFail++;
        }

        if (isCloudinaryUrl(thumb)) {
          const r = await migrateItem({
            id: String(v.id),
            title: `${title} (thumbnail)`,
            zoneId,
            category: 'videos',
            field: 'thumbnail',
            stemKey: 'thumb',
            url: thumb,
            defaultExt: 'jpg',
          });
          r ? totalOk++ : totalFail++;
        }

        if (!DRY_RUN) await new Promise((r) => setTimeout(r, 250));
      }
    }
  } catch (err: any) {
    console.log('   ℹ️  media_videos table not queried / not present.');
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`🎉 Migration Complete!`);
  console.log(`✅  Successfully Migrated: ${totalOk}`);
  console.log(`❌  Failed:                ${totalFail}`);
  console.log(`\n📄  Success Map CSV: → ${CSV_PATH}`);
  console.log(`📄  Failed Map CSV:  → ${FAILED_PATH}`);
  if (totalFail > 0) {
    console.log('\n⚠️  Failed files can be retried by running the script again.');
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('💥 Fatal Migration Error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
