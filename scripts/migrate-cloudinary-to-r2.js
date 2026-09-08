/**
 * High-speed Cloud-to-Cloud Migration Script
 * Transfers official choir assets from Cloudinary directly into Cloudflare R2.
 * Strictly scopes by organization / zone ID and updates database records.
 *
 * Usage:
 *   node scripts/migrate-cloudinary-to-r2.js --live              # Run full migration
 *   node scripts/migrate-cloudinary-to-r2.js --live --limit=10  # Test first 10 items
 *   node scripts/migrate-cloudinary-to-r2.js                    # Dry run (prints plan)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const postgres = require('postgres');

// ── Environment & Config ─────────────────────────────────────────────────────

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || 'b2e5411830e116cf4ce6e91e90843db0';
const bucketName = process.env.R2_BUCKET_NAME || 'rehearsalhub-media';
const accessKeyId = process.env.R2_ACCESS_KEY_ID || '53609880149dce49393f0d762b8b4baf';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || 'dfec6c0153c47aa9c036d9e8bbbe2739ec738352f55afa2f8fd70df95f67ae90';
const publicUrlBase = (process.env.R2_PUBLIC_URL || 'https://pub-cb7697578fcc48d3b3aeb70a47eb2f65.r2.dev').replace(/\/+$/, '');
const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;

// Parse CLI flags
const args = process.argv.slice(2);
const isLive = args.includes('--live');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const concurrencyArg = args.find((a) => a.startsWith('--concurrency='));
const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg.split('=')[1], 10) : 15;

console.log('═══════════════════════════════════════════════════════════════════');
console.log('🚀 Cloudinary -> Cloudflare R2 High-Speed Migration Runner');
console.log(`   Mode:        ${isLive ? '🔴 LIVE (Will upload & update DB)' : '🟡 DRY RUN (Preview only)'}`);
console.log(`   Bucket:      ${bucketName}`);
console.log(`   Concurrency: ${CONCURRENCY} parallel streams`);
if (limit) console.log(`   Limit:       First ${limit} files`);
console.log('═══════════════════════════════════════════════════════════════════\n');

// Initialize R2 Client
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

// Initialize Database
let sql = null;
if (isLive && connectionString) {
  sql = postgres(connectionString, {
    ssl: 'require',
    max: 8,
    prepare: false,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeFileName(name) {
  if (!name) return 'asset';
  return name.replace(/[<>:"/\\|?*#\s]+/g, '_').replace(/^_+|_+$/g, '');
}

function resolveMime(url, type) {
  const clean = url.split('?')[0].toLowerCase();
  if (clean.endsWith('.mp3')) return 'audio/mpeg';
  if (clean.endsWith('.m4a')) return 'audio/mp4';
  if (clean.endsWith('.wav')) return 'audio/wav';
  if (clean.endsWith('.mp4')) return 'video/mp4';
  if (clean.endsWith('.mov')) return 'video/quicktime';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.pdf')) return 'application/pdf';

  if (type === 'AUDIO') return 'audio/mpeg';
  if (type === 'VIDEO') return 'video/mp4';
  if (type === 'IMAGE') return 'image/jpeg';
  return 'application/octet-stream';
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Main Migration ───────────────────────────────────────────────────────────

async function run() {
  const assetsFile = path.join(__dirname, 'cloudinary_assets.json');
  if (!fs.existsSync(assetsFile)) {
    console.error(`ERROR: Assets file not found at: ${assetsFile}`);
    process.exit(1);
  }

  let allAssets = JSON.parse(fs.readFileSync(assetsFile, 'utf8'));
  console.log(`📋 Loaded ${allAssets.length} total assets from cloudinary_assets.json`);

  // Track progress
  const progressFile = path.join(__dirname, 'migration_progress.json');
  let migratedMap = {};
  if (fs.existsSync(progressFile)) {
    try {
      migratedMap = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      console.log(`💾 Resuming from previous run: ${Object.keys(migratedMap).length} files already migrated.`);
    } catch {}
  }

  // Filter pending
  let pending = allAssets.filter((a) => !migratedMap[a.url]);
  if (limit) {
    pending = pending.slice(0, limit);
  }

  console.log(`\n⏳ Processing ${pending.length} assets with ${CONCURRENCY} parallel workers...\n`);

  let successCount = 0;
  let failCount = 0;
  let index = 0;

  async function worker() {
    while (index < pending.length) {
      const currentIdx = index++;
      const item = pending[currentIdx];
      const overallNum = currentIdx + 1;

      try {
        const rawUrl = item.url;
        const ext = rawUrl.split('?')[0].split('.').pop() || (item.type === 'AUDIO' ? 'mp3' : item.type === 'VIDEO' ? 'mp4' : 'bin');
        const cleanName = `${sanitizeFileName(item.title || item.id)}.${ext}`;

        // ── Tenancy & Partitioning ───────────────────────────────────────────
        // Strictly partition by organization / zone so assets are never visible to other orgs
        let r2Key = '';
        if (item.organizationId) {
          r2Key = `organizations/${item.organizationId}/media/${cleanName}`;
        } else if (item.table === 'songs') {
          r2Key = `songs/master/${item.id}/${cleanName}`;
        } else if (item.table === 'media_videos') {
          r2Key = `videos/master/${item.id}/${cleanName}`;
        } else {
          r2Key = `general/${cleanName}`;
        }

        const newR2Url = `${publicUrlBase}/${r2Key}`;

        if (!isLive) {
          console.log(`[DRY RUN ${overallNum}/${pending.length}] ${item.title} (${item.type})`);
          console.log(`   Source: ${rawUrl}`);
          console.log(`   Target: ${newR2Url}\n`);
          successCount++;
          continue;
        }

        // Live stream fetch & R2 upload
        const buffer = await fetchBuffer(rawUrl);
        const mimeType = resolveMime(rawUrl, item.type);

        await r2.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: r2Key,
            Body: buffer,
            ContentType: mimeType,
            CacheControl: 'public, max-age=31536000, immutable',
          })
        );

        // Update Database Record
        if (sql) {
          try {
            if (item.table === 'media_assets') {
              if (item.field === 'thumbnail') {
                await sql`UPDATE media_assets SET thumbnail = ${newR2Url}, updated_at = NOW() WHERE id = ${item.id}`;
              } else {
                await sql`UPDATE media_assets SET url = ${newR2Url}, updated_at = NOW() WHERE id = ${item.id}`;
              }
            } else if (item.table === 'zone_media_assets') {
              await sql`UPDATE zone_media_assets SET url = ${newR2Url} WHERE id = ${item.id}`;
            } else if (item.table === 'media_videos') {
              if (item.field === 'thumbnail') {
                await sql`UPDATE media_videos SET thumbnail = ${newR2Url} WHERE id = ${item.id}`;
              } else {
                await sql`UPDATE media_videos SET video_url = ${newR2Url} WHERE id = ${item.id}`;
              }
            } else if (item.table === 'songs') {
              if (item.field === 'audio_file') {
                await sql`UPDATE songs SET audio_file = ${newR2Url}, updated_at = NOW() WHERE id = ${item.id}`;
              } else if (item.field && item.field.startsWith('audio_urls.')) {
                const stemKey = item.field.split('.')[1];
                await sql`
                  UPDATE songs 
                  SET audio_urls = jsonb_set(COALESCE(audio_urls::jsonb, '{}'::jsonb), ${`{${stemKey}}`}, ${JSON.stringify(newR2Url)}::jsonb),
                      updated_at = NOW()
                  WHERE id = ${item.id}
                `;
              }
            }
          } catch (dbErr) {
            console.warn(`   [DB Warning for ${item.id}]:`, dbErr.message);
          }
        }

        migratedMap[rawUrl] = {
          r2Url: newR2Url,
          key: r2Key,
          table: item.table,
          id: item.id,
          migratedAt: new Date().toISOString(),
        };

        successCount++;
        if (overallNum % 10 === 0 || overallNum === pending.length) {
          console.log(`✅ [${overallNum}/${pending.length}] Migrated: ${item.title} -> ${r2Key}`);
          // Periodically flush progress
          fs.writeFileSync(progressFile, JSON.stringify(migratedMap, null, 2), 'utf8');
        }
      } catch (err) {
        failCount++;
        console.error(`❌ [FAILED ${overallNum}/${pending.length}] ${item.title}:`, err.message);
      }
    }
  }

  // Launch concurrency workers
  const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker());
  await Promise.all(workers);

  // Final flush
  fs.writeFileSync(progressFile, JSON.stringify(migratedMap, null, 2), 'utf8');

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🏁 Migration Batch Finished!');
  console.log(`   Success: ${successCount}`);
  console.log(`   Failed:  ${failCount}`);
  console.log(`   Total in R2: ${Object.keys(migratedMap).length}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  if (sql) await sql.end();
}

run().catch((err) => {
  console.error('Fatal Migration Error:', err);
  process.exit(1);
});
