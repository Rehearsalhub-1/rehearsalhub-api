/**
 * ============================================================================
 * Cloudinary → R2 Mass Migration Script
 * Run via: npx ts-node scripts/migrate-cloudinary-to-r2.ts
 * Or via GitHub Actions: .github/workflows/migrate-cloudinary-to-r2.yml
 * ============================================================================
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { uploadToR2 } from '../src/services/r2Service';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'true';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isCloudinaryUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes('cloudinary.com') || url.includes('res.cloudinary.com');
}

function getExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace('.', '');
    return ext || 'mp3';
  } catch { return 'mp3'; }
}

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
    aac: 'audio/aac',  ogg: 'audio/ogg',  flac: 'audio/flac',
    webm: 'audio/webm', mp4: 'video/mp4',  mov: 'video/quicktime',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

function downloadFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) { downloadFile(loc).then(resolve).catch(reject); return; }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`)); return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── CSV Output ────────────────────────────────────────────────────────────────

const OUT_DIR     = path.join(__dirname);
const CSV_PATH    = path.join(OUT_DIR, 'cloudinary-migration-map.csv');
const FAILED_PATH = path.join(OUT_DIR, 'cloudinary-migration-failed.csv');

function initCsv() {
  fs.writeFileSync(CSV_PATH,    'songId,songTitle,zoneId,field,stemKey,oldUrl,newR2Url\n');
  fs.writeFileSync(FAILED_PATH, 'songId,songTitle,field,stemKey,oldUrl,error\n');
}

const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

function appendSuccess(r: { songId: string; songTitle: string; zoneId: string; field: string; stemKey: string; oldUrl: string; newR2Url: string }) {
  fs.appendFileSync(CSV_PATH, [r.songId, q(r.songTitle), r.zoneId, r.field, r.stemKey, r.oldUrl, r.newR2Url].join(',') + '\n');
}

function appendFailed(r: { songId: string; songTitle: string; field: string; stemKey: string; oldUrl: string; error: string }) {
  fs.appendFileSync(FAILED_PATH, [r.songId, q(r.songTitle), r.field, r.stemKey, r.oldUrl, q(r.error)].join(',') + '\n');
}

// ── Core ──────────────────────────────────────────────────────────────────────

async function migrateFile(opts: {
  songId: string; songTitle: string; zoneId: string;
  field: string; stemKey: string; url: string;
}): Promise<boolean> {
  const { songId, songTitle, zoneId, field, stemKey, url } = opts;

  if (!isCloudinaryUrl(url)) {
    console.log(`    ⏭  SKIP (not Cloudinary): ${field}/${stemKey}`);
    return true;
  }

  if (DRY_RUN) {
    console.log(`    🔍 DRY RUN: would migrate ${field}/${stemKey} → zones/${zoneId}/songs/`);
    appendSuccess({ songId, songTitle, zoneId, field, stemKey, oldUrl: url, newR2Url: 'DRY_RUN' });
    return true;
  }

  try {
    console.log(`    ⬇  Download: ${url.slice(0, 90)}...`);
    const buffer = await downloadFile(url);
    const ext    = getExtensionFromUrl(url);
    const folder = `zones/${zoneId}/songs`;
    const filename = `${songId}_${field}_${stemKey}.${ext}`;

    console.log(`    ⬆  Upload to R2: ${folder}/${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    const result = await uploadToR2(buffer, { folder, filename, contentType: getMimeType(ext) });

    appendSuccess({ songId, songTitle, zoneId, field, stemKey, oldUrl: url, newR2Url: result.url });
    console.log(`    ✅ ${result.url}`);
    return true;
  } catch (err: any) {
    const error = err?.message || String(err);
    console.error(`    ❌ FAILED: ${error}`);
    appendFailed({ songId, songTitle, field, stemKey, oldUrl: url, error });
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🚀 Cloudinary → R2 Migration ${DRY_RUN ? '[DRY RUN]' : ''}\n`);
  initCsv();

  const songs = await prisma.song.findMany({
    select: { id: true, title: true, organizationId: true, audioFile: true, audioUrls: true },
  });

  const targets = songs.filter(
    (s) => isCloudinaryUrl(s.audioFile) ||
           (s.audioUrls && typeof s.audioUrls === 'object' &&
            Object.values(s.audioUrls as Record<string, string>).some(isCloudinaryUrl))
  );

  console.log(`📊 Total songs:              ${songs.length}`);
  console.log(`☁️  Songs with Cloudinary:   ${targets.length}\n`);

  let ok = 0, fail = 0;

  for (let i = 0; i < targets.length; i++) {
    const song   = targets[i];
    const zoneId = song.organizationId || 'zone-hq';
    console.log(`\n[${i + 1}/${targets.length}] 🎵 "${song.title}"  zone: ${zoneId}`);

    // Main mix
    if (isCloudinaryUrl(song.audioFile)) {
      const r = await migrateFile({ songId: song.id, songTitle: song.title, zoneId, field: 'audioFile', stemKey: 'full', url: song.audioFile! });
      r ? ok++ : fail++;
    }

    // Stems
    if (song.audioUrls && typeof song.audioUrls === 'object') {
      for (const [stemKey, stemUrl] of Object.entries(song.audioUrls as Record<string, string>)) {
        if (!isCloudinaryUrl(stemUrl)) continue;
        const r = await migrateFile({ songId: song.id, songTitle: song.title, zoneId, field: 'audioUrls', stemKey, url: stemUrl });
        r ? ok++ : fail++;
      }
    }

    // Rate-limit courtesy delay
    if (!DRY_RUN) await new Promise((r) => setTimeout(r, 400));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`✅  Succeeded : ${ok}`);
  console.log(`❌  Failed    : ${fail}`);
  console.log(`\n📄  Map    → ${CSV_PATH}`);
  console.log(`📄  Failed → ${FAILED_PATH}`);
  if (fail > 0) console.log('\n⚠️  Re-run the script — failed files will be retried (already-migrated ones are skipped).');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('💥', err);
  await prisma.$disconnect();
  process.exit(1);
});
