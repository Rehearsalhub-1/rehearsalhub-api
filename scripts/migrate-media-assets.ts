/**
 * Migration script for Firebase Firestore:
 * - cloudinary_media (7623 docs)
 * - zone_cloudinary_media (142 docs)
 * Into PostgreSQL media_assets table via Prisma.
 *
 * Run: npx tsx scripts/migrate-media-assets.ts
 */
import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import prisma from '../src/lib/prisma';

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'loveworld-singers-app',
  });
}

const db = admin.firestore();

function normalizeZoneId(rawZone: any, validOrgIds: Set<string>): string {
  if (!rawZone || rawZone === 'global') return 'zone-001';
  let z = String(rawZone).trim().toLowerCase();
  if (validOrgIds.has(z)) return z;

  // Handle format zone001 -> zone-001 or zone1 -> zone-001
  const m = z.match(/^zone-?(\d+)$/);
  if (m) {
    const num = parseInt(m[1], 10);
    const padded = `zone-${String(num).padStart(3, '0')}`;
    if (validOrgIds.has(padded)) return padded;
  }

  return 'zone-001';
}

function detectType(data: any): string {
  const url = String(data.url || data.videoUrl || '').toLowerCase();
  const rawType = String(data.type || data.mediaType || '').toLowerCase();
  if (rawType === 'video' || url.includes('youtube.com') || url.includes('youtu.be') || url.match(/\.(mp4|webm|mov|mkv)$/)) {
    return 'VIDEO';
  }
  if (rawType === 'image' || url.match(/\.(jpg|jpeg|png|gif|webp|svg)$/)) {
    return 'IMAGE';
  }
  return 'AUDIO';
}

async function migrateMedia() {
  console.log('=== Starting Media Assets Migration ===\n');

  // Load existing valid organizations and subgroups to enforce FK constraints
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const validOrgIds = new Set(orgs.map((o) => o.id.toLowerCase()));
  console.log(`Loaded ${validOrgIds.size} valid organization IDs from DB.`);

  const subgroups = await prisma.subgroup.findMany({ select: { id: true } });
  const validSubgroupIds = new Set(subgroups.map((s) => s.id));
  console.log(`Loaded ${validSubgroupIds.size} valid subgroup IDs from DB.\n`);

  const collections = [
    { name: 'cloudinary_media', defaultFolder: 'audio' },
    { name: 'zone_cloudinary_media', defaultFolder: 'zone-media' },
  ];

  let totalMigrated = 0;

  for (const col of collections) {
    console.log(`--- Fetching ${col.name} from Firebase ---`);
    const snapshot = await db.collection(col.name).get();
    console.log(`Found ${snapshot.size} documents in ${col.name}.`);

    const records: any[] = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const id = doc.id;
      let orgId = normalizeZoneId(
        data.zoneId || data.organizationId || data.organization_id || data.zone_id || data.orgId,
        validOrgIds
      );
      const subgroupId =
        data.subgroupId || data.subgroup_id || data.churchId || data.church_id || data.subGroupId || null;
      const validSubgroupId = subgroupId && validSubgroupIds.has(subgroupId) ? subgroupId : null;
      const mediaType = detectType(data);
      const title = data.name || data.title || 'Untitled Asset';
      const folder = data.folder || col.defaultFolder;
      const size = typeof data.size === 'number' ? Math.round(data.size) : null;
      const format = data.format || (data.url?.split('.').pop() || null);
      const mimeType = format ? `${mediaType.toLowerCase()}/${format}` : null;

      const rawData = {
        ...data,
        id,
        title,
        name: title,
        organizationId: orgId,
        subgroupId: validSubgroupId,
        churchId: validSubgroupId || subgroupId,
        zoneId: orgId,
        sourceCollection: col.name,
      };

      records.push({
        id,
        organizationId: orgId,
        subgroupId: validSubgroupId,
        title,
        type: mediaType,
        folder,
        size,
        mimeType,
        rawData,
      });
    }

    // Insert in batches of 250 using prisma createMany with skipDuplicates
    console.log(`Migrating ${records.length} records in batches...`);
    const BATCH_SIZE = 250;
    let insertedCount = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const res = await prisma.mediaAsset.createMany({
        data: batch,
        skipDuplicates: true,
      });
      insertedCount += res.count;
      if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= records.length) {
        console.log(`  Processed ${Math.min(i + BATCH_SIZE, records.length)} / ${records.length} (${insertedCount} new inserts)`);
      }
    }

    console.log(`Completed ${col.name}: ${insertedCount} records inserted into media_assets.\n`);
    totalMigrated += insertedCount;
  }

  const finalCount = await prisma.mediaAsset.count();
  console.log(`=== Media Assets Migration Completed ===`);
  console.log(`Total Media Assets in DB: ${finalCount} (Newly migrated: ${totalMigrated})`);

  await admin.app().delete();
}

migrateMedia()
  .catch((err) => {
    console.error('Migration error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
