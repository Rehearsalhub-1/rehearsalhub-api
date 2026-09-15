import dns from 'dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);

import dotenv from 'dotenv';
dotenv.config();

import https from 'https';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import prisma from '../src/lib/prisma';
import { uploadToR2 } from '../src/services/r2Service';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'dvtjjt3js';
const API_KEY = process.env.CLOUDINARY_API_KEY || '696485534226686';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || 'rBWR9HSNegYoEQ5lLzrMqGOv0zk';
const AUTH_HEADER = 'Basic ' + Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
const TARGET_ZONE_ID = 'zone-001'; // Loveworld Singers HQ

interface CloudinaryResource {
  asset_id: string;
  public_id: string;
  format: string;
  version: number;
  resource_type: string;
  type: string;
  created_at: string;
  bytes: number;
  width?: number;
  height?: number;
  folder?: string;
  url: string;
  secure_url: string;
  filename?: string;
}

function fetchCloudinaryPage(nextCursor: string | null = null): Promise<{ resources: CloudinaryResource[]; next_cursor?: string }> {
  return new Promise((resolve, reject) => {
    const payload: any = {
      expression: 'created_at >= 2026-08-31',
      max_results: 100,
      sort_by: [{ created_at: 'desc' }],
    };
    if (nextCursor) {
      payload.next_cursor = nextCursor;
    }

    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/resources/search`,
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`Cloudinary API error ${res.statusCode}: ${body}`));
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Cloudinary search request timed out'));
    });
    req.write(data);
    req.end();
  });
}

function downloadFile(url: string, maxRedirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: { 'User-Agent': 'RehearsalHubMediaMigrator/2.0' },
      timeout: 90000,
    }, (res) => {
      if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (loc) {
          const redirectUrl = loc.startsWith('http') ? loc : new URL(loc, url).toString();
          return downloadFile(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        }
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

function inferType(resourceType: string, format: string): 'AUDIO' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' {
  const f = (format || '').toLowerCase();
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm', 'wma'].includes(f)) return 'AUDIO';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(f)) return 'IMAGE';
  if (['mp4', 'mov', 'avi', 'mkv'].includes(f)) return 'VIDEO';
  if (resourceType === 'image') return 'IMAGE';
  if (resourceType === 'video') return 'AUDIO'; // Cloudinary classes audio as video
  return 'DOCUMENT';
}

function getMimeType(format: string): string {
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
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
    gif: 'image/gif',
  };
  return map[(format || '').toLowerCase()] || 'application/octet-stream';
}

async function main() {
  console.log('====================================================');
  console.log('🚀 CLOUDINARY → CLOUDFLARE R2 MIGRATION & DB SYNC');
  console.log(`🎯 Target Zone: ${TARGET_ZONE_ID} (Loveworld Singers HQ)`);
  console.log('====================================================\n');

  console.log('1. Fetching all uploads from Cloudinary (since 2026-08-31)...');
  const allResources: CloudinaryResource[] = [];
  let nextCursor: string | null = null;

  do {
    const page = await fetchCloudinaryPage(nextCursor);
    if (page.resources && page.resources.length > 0) {
      allResources.push(...page.resources);
      console.log(`   Fetched ${page.resources.length} items (Total: ${allResources.length})`);
    }
    nextCursor = page.next_cursor || null;
  } while (nextCursor);

  console.log(`\nFound ${allResources.length} total resources to migrate.\n`);

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < allResources.length; i++) {
    const r = allResources[i];
    const rawPublicId = r.public_id;
    const filename = `${path.basename(rawPublicId)}.${r.format}`;
    const mediaType = inferType(r.resource_type, r.format);
    const mimeType = getMimeType(r.format);
    const folder = r.folder || 'general';
    const cleanTitle = path.basename(rawPublicId).replace(/[-_]/g, ' ');

    console.log(`[${i + 1}/${allResources.length}] Migrating: ${filename} (${(r.bytes / 1024 / 1024).toFixed(2)} MB)...`);

    // Check if already in DB with R2 URL
    const existingAsset = await prisma.mediaAsset.findFirst({
      where: {
        organizationId: TARGET_ZONE_ID,
        OR: [
          { title: cleanTitle },
          { url: { contains: path.basename(rawPublicId) } },
        ],
      },
    });

    if (existingAsset && !existingAsset.url.includes('cloudinary.com')) {
      console.log(`   ⏭  Already in R2 and DB: ${existingAsset.url}`);
      skipCount++;
      continue;
    }

    try {
      // 1. Download file from Cloudinary
      const fileBuffer = await downloadFile(r.secure_url);

      // 2. Upload to Cloudflare R2 under zones/zone-001/media/
      const r2Folder = `zones/${TARGET_ZONE_ID}/media/${folder}`;
      const uploadRes = await uploadToR2(fileBuffer, {
        folder: r2Folder,
        filename,
        contentType: mimeType,
      });

      console.log(`   ☁️  Uploaded to R2: ${uploadRes.url}`);

      // 3. Upsert into media_assets table in DB
      const assetId = existingAsset?.id || `cld_${crypto.createHash('md5').update(r.asset_id || r.public_id).digest('hex').slice(0, 20)}`;

      await prisma.mediaAsset.upsert({
        where: { id: assetId },
        create: {
          id: assetId,
          organizationId: TARGET_ZONE_ID,
          title: cleanTitle,
          url: uploadRes.url,
          type: mediaType,
          folder: folder,
          size: BigInt(r.bytes),
          mimeType,
          createdAt: new Date(r.created_at),
          updatedAt: new Date(),
        },
        update: {
          organizationId: TARGET_ZONE_ID,
          url: uploadRes.url,
          type: mediaType,
          folder: folder,
          size: BigInt(r.bytes),
          mimeType,
          updatedAt: new Date(),
        },
      });

      console.log(`   ✅ DB record saved for Loveworld Singers HQ!`);
      successCount++;
    } catch (err: any) {
      console.error(`   ❌ Failed: ${err.message || err}`);
      failCount++;
    }

    // Rate-limit courtesy delay
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.log('\n====================================================');
  console.log('🎉 MIGRATION SUMMARY:');
  console.log(`   Total Found:    ${allResources.length}`);
  console.log(`   Uploaded to R2: ${successCount}`);
  console.log(`   Skipped (Done): ${skipCount}`);
  console.log(`   Failed:         ${failCount}`);
  console.log('====================================================');

  await prisma.$disconnect();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Fatal Migration Error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
