/**
 * Firebase → Prisma Migration Script
 * READ-ONLY from Firebase. WRITE-ONLY to Prisma (upsert, never delete).
 * Run: npx tsx scripts/firebase-migrate.ts
 *
 * Order:
 *   1. profiles        (users)
 *   2. memberships     (hq_members + zone_members)
 *   3. songs           (master_songs → isMinistered:true, praise_night_songs, zone_songs, subgroup_songs)
 *   4. programs        (praise_nights + zone_praise_nights + master_programs)
 *   5. attendance
 *   6. categories
 *   7. submitted_songs
 *   8. subgroups
 *   9. analytics_events (simplified — one row per day per org, not raw events)
 */

import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// ── Prisma client ────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
  max: 5,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

// ── Firebase client ──────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: 'loveworld-singers-app' });
const db = admin.firestore();

// ── Helpers ──────────────────────────────────────────────────────────────────
function ts(val: any): Date | null {
  if (!val) return null;
  if (val?.toDate) return val.toDate();
  if (val instanceof Date) return val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}
function str(val: any): string | null {
  if (val == null) return null;
  return String(val).trim() || null;
}
function bool(val: any): boolean {
  return !!val;
}

let totalInserted = 0;

async function readAll(collectionId: string): Promise<admin.firestore.QueryDocumentSnapshot[]> {
  const snap = await db.collection(collectionId).get();
  return snap.docs;
}

// ── 1. PROFILES ──────────────────────────────────────────────────────────────
async function migrateProfiles() {
  console.log('\n[1/9] Migrating profiles...');
  const docs = await readAll('profiles');
  let count = 0;
  for (const doc of docs) {
    const d = doc.data();
    const id = doc.id;
    try {
      await prisma.user.upsert({
        where: { id },
        create: {
          id,
          email: str(d.email || d.userEmail),
          name: str(d.displayName || d.fullName || `${d.first_name || ''} ${d.last_name || ''}`.trim()),
          firstName: str(d.first_name || d.firstName),
          lastName: str(d.last_name || d.lastName),
          phone: str(d.phone_number || d.phoneNumber),
          avatarUrl: str(d.profile_image_url || d.avatar_url || d.photoURL || d.avatarUrl),
          kingschatId: str(d.kingschat_id || d.kingschatId),
          profileCompleted: bool(d.profile_completed || d.profileCompleted),
          createdAt: ts(d.created_at || d.createdAt),
          updatedAt: ts(d.updated_at || d.updatedAt),
          rawData: d,
        },
        update: {
          email: str(d.email || d.userEmail),
          name: str(d.displayName || d.fullName || `${d.first_name || ''} ${d.last_name || ''}`.trim()),
          firstName: str(d.first_name || d.firstName),
          lastName: str(d.last_name || d.lastName),
          phone: str(d.phone_number || d.phoneNumber),
          avatarUrl: str(d.profile_image_url || d.avatar_url || d.photoURL || d.avatarUrl),
          kingschatId: str(d.kingschat_id || d.kingschatId),
          profileCompleted: bool(d.profile_completed || d.profileCompleted),
          rawData: d,
        },
      });
      count++;
    } catch (e: any) {
      console.warn(`  profile ${id}: ${e.message?.split('\n')[0]}`);
    }
  }
  console.log(`  ✓ ${count} profiles`);
  totalInserted += count;
}

// ── 2. MEMBERSHIPS ───────────────────────────────────────────────────────────
async function migrateMemberships() {
  console.log('\n[2/9] Migrating memberships...');
  let count = 0;

  const hqDocs = await readAll('hq_members');
  for (const doc of hqDocs) {
    const d = doc.data();
    const userId = str(d.userId || d.user_id);
    const orgId = str(d.hqGroupId || d.zoneId);
    if (!userId || !orgId) continue;
    try {
      await prisma.membership.upsert({
        where: { userId_organizationId: { userId, organizationId: orgId } },
        create: {
          userId,
          organizationId: orgId,
          role: str(d.role) || 'MEMBER',
          hasHqAccess: true,
          status: 'ACTIVE',
          joinedAt: ts(d.joinedAt || d.createdAt) || new Date(),
        },
        update: {
          role: str(d.role) || 'MEMBER',
          hasHqAccess: true,
          status: 'ACTIVE',
        },
      });
      count++;
    } catch (e: any) {
      console.warn(`  hq_member ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }

  const zoneDocs = await readAll('zone_members');
  for (const doc of zoneDocs) {
    const d = doc.data();
    const userId = str(d.userId || d.user_id);
    const orgId = str(d.zoneId || d.zone_id);
    if (!userId || !orgId) continue;
    try {
      await prisma.membership.upsert({
        where: { userId_organizationId: { userId, organizationId: orgId } },
        create: {
          userId,
          organizationId: orgId,
          role: str(d.role) || 'MEMBER',
          hasHqAccess: false,
          status: 'ACTIVE',
          joinedAt: ts(d.joinedAt || d.createdAt) || new Date(),
        },
        update: {
          role: str(d.role) || 'MEMBER',
          status: 'ACTIVE',
        },
      });
      count++;
    } catch (e: any) {
      console.warn(`  zone_member ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }

  console.log(`  ✓ ${count} memberships`);
  totalInserted += count;
}

// ── 3. SONGS ─────────────────────────────────────────────────────────────────
async function migrateSongs() {
  console.log('\n[3/9] Migrating songs...');
  let count = 0;

  // master_songs → isMinistered: true, no org (global)
  const masterDocs = await readAll('master_songs');
  for (const doc of masterDocs) {
    const d = doc.data();
    try {
      await prisma.song.upsert({
        where: { id: doc.id },
        create: {
          id: doc.id,
          title: str(d.title),
          key: str(d.key),
          tempo: str(d.tempo),
          lyrics: str(d.lyrics),
          writer: str(d.writer),
          category: str(d.category),
          audioFile: str(d.audioFile || d.audio_file),
          audioUrls: d.audioUrls || d.audio_urls || null,
          conductor: str(d.conductor),
          leadSinger: str(d.leadSinger || d.lead_singer),
          drummer: str(d.drummer),
          leadKeyboardist: str(d.leadKeyboardist),
          solfas: str(d.solfa || d.solfas),
          isMinistered: true,
          isActive: bool(d.isActive !== false),
          rawData: d,
        },
        update: {
          title: str(d.title),
          key: str(d.key),
          tempo: str(d.tempo),
          isMinistered: true,
          rawData: d,
        },
      });
      count++;
    } catch (e: any) {
      console.warn(`  master_song ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }

  // praise_night_songs
  const pnSongDocs = await readAll('praise_night_songs');
  for (const doc of pnSongDocs) {
    const d = doc.data();
    try {
      await prisma.song.upsert({
        where: { id: doc.id },
        create: {
          id: doc.id,
          title: str(d.title),
          key: str(d.key),
          tempo: str(d.tempo),
          lyrics: str(d.lyrics),
          writer: str(d.writer),
          category: str(d.category),
          audioFile: str(d.audioFile || d.audio_file),
          conductor: str(d.conductor),
          leadSinger: str(d.leadSinger || d.lead_singer),
          drummer: str(d.drummer),
          solfas: str(d.solfas || d.solfa),
          programId: str(d.praiseNightId || d.praise_night_id || d.programId),
          status: str(d.status) || 'active',
          isActive: bool(d.isActive !== false),
          isMinistered: false,
          rawData: d,
        },
        update: {
          title: str(d.title),
          programId: str(d.praiseNightId || d.praise_night_id || d.programId),
          rawData: d,
        },
      });
      count++;
    } catch (e: any) {
      console.warn(`  pn_song ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }

  // zone_songs
  const zoneSongDocs = await readAll('zone_songs');
  for (const doc of zoneSongDocs) {
    const d = doc.data();
    try {
      await prisma.song.upsert({
        where: { id: doc.id },
        create: {
          id: doc.id,
          title: str(d.title),
          key: str(d.key),
          tempo: str(d.tempo),
          writer: str(d.writer),
          category: str(d.category),
          organizationId: str(d.zoneId || d.zone_id),
          isMinistered: false,
          isActive: true,
          rawData: d,
        },
        update: { title: str(d.title), rawData: d },
      });
      count++;
    } catch (e: any) {
      console.warn(`  zone_song ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }

  // subgroup_songs
  const sgSongDocs = await readAll('subgroup_songs');
  for (const doc of sgSongDocs) {
    const d = doc.data();
    try {
      await prisma.song.upsert({
        where: { id: doc.id },
        create: {
          id: doc.id,
          title: str(d.title),
          key: str(d.key),
          tempo: str(d.tempo),
          isMinistered: false,
          isActive: true,
          rawData: d,
        },
        update: { title: str(d.title), rawData: d },
      });
      count++;
    } catch (e: any) {
      console.warn(`  sg_song ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }

  console.log(`  ✓ ${count} songs`);
  totalInserted += count;
}

// ── 4. PROGRAMS ──────────────────────────────────────────────────────────────
async function migratePrograms() {
  console.log('\n[4/9] Migrating programs...');
  let count = 0;

  const migrateCollection = async (collectionId: string, orgId?: string) => {
    const docs = await readAll(collectionId);
    for (const doc of docs) {
      const d = doc.data();
      try {
        await prisma.program.upsert({
          where: { id: doc.id },
          create: {
            id: doc.id,
            name: str(d.name),
            date: str(d.date),
            location: str(d.location),
            category: str(d.category || d.status) || 'pre-rehearsal',
            status: str(d.category || d.status) || 'pre-rehearsal',
            isActive: bool(d.isActive),
            isArchived: bool(d.isArchived),
            bannerImage: str(d.bannerImage),
            organizationId: str(d.zoneId || d.zone_id) || orgId || null,
            songs: d.songs || null,
            songIds: d.songIds || null,
            rawData: d,
          },
          update: {
            name: str(d.name),
            date: str(d.date),
            status: str(d.category || d.status) || 'pre-rehearsal',
            rawData: d,
          },
        });
        count++;
      } catch (e: any) {
        console.warn(`  program ${doc.id} (${collectionId}): ${e.message?.split('\n')[0]}`);
      }
    }
  };

  await migrateCollection('praise_nights');
  await migrateCollection('zone_praise_nights');
  await migrateCollection('master_programs', 'zone-001'); // HQ org

  console.log(`  ✓ ${count} programs`);
  totalInserted += count;
}

// ── 5. ATTENDANCE ────────────────────────────────────────────────────────────
async function migrateAttendance() {
  console.log('\n[5/9] Migrating attendance...');
  const docs = await readAll('attendance');
  let count = 0;
  for (const doc of docs) {
    const d = doc.data();
    const userId = str(d.user_id || d.userId);
    const orgId = str(d.zoneId || d.zone_id);
    try {
      await prisma.attendance.upsert({
        where: { id: doc.id },
        create: {
          id: doc.id,
          userId,
          organizationId: orgId,
          eventName: str(d.event_name || d.eventName),
          status: str(d.status) || 'present',
          checkInTime: ts(d.check_in_time || d.checkInTime || d.date),
          qrCode: str(d.qr_code || d.qrCode),
          rawData: d,
        },
        update: {
          userId,
          organizationId: orgId,
          rawData: d,
        },
      });
      count++;
    } catch (e: any) {
      console.warn(`  attendance ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }
  console.log(`  ✓ ${count} attendance records`);
  totalInserted += count;
}

// ── 6. CATEGORIES ────────────────────────────────────────────────────────────
async function migrateCategories() {
  console.log('\n[6/9] Migrating categories...');
  let count = 0;

  const migrateCol = async (colId: string) => {
    const docs = await readAll(colId);
    for (const doc of docs) {
      const d = doc.data();
      const orgId = str(d.zoneId || d.zone_id);
      const name = str(d.name);
      if (!name) continue;
      try {
        // Categories have a unique constraint on (organizationId, name, type)
        const existing = await prisma.category.findFirst({
          where: { organizationId: orgId, name, type: 'PROGRAM' },
        });
        if (!existing) {
          await prisma.category.create({
            data: {
              id: doc.id,
              name,
              organizationId: orgId,
              type: 'PROGRAM',
              color: str(d.color),
              rawData: d,
            },
          });
        }
        count++;
      } catch (e: any) {
        console.warn(`  category ${doc.id}: ${e.message?.split('\n')[0]}`);
      }
    }
  };

  await migrateCol('categories');
  await migrateCol('zone_categories');
  await migrateCol('page_categories');

  console.log(`  ✓ ${count} categories`);
  totalInserted += count;
}

// ── 7. SUBMITTED SONGS ───────────────────────────────────────────────────────
async function migrateSubmittedSongs() {
  console.log('\n[7/9] Migrating submitted_songs...');
  const docs = await readAll('submitted_songs');
  let count = 0;
  for (const doc of docs) {
    const d = doc.data();
    try {
      await prisma.submittedSong.upsert({
        where: { id: doc.id },
        create: {
          id: doc.id,
          title: str(d.title),
          userId: str(d.userId || d.user_id),
          zoneId: str(d.zoneId || d.zone_id),    // organizationId in Prisma maps to zoneId column
          status: str(d.status) || 'pending',
          submittedBy: str(d.submittedBy || d.submitted_by),
          submittedByEmail: str(d.submittedByEmail || d.submitted_by_email || d.userEmail),
          createdAt: ts(d.createdAt || d.created_at) || new Date(),
          rawData: d,
        },
        update: {
          title: str(d.title),
          status: str(d.status) || 'pending',
          rawData: d,
        },
      });
      count++;
    } catch (e: any) {
      console.warn(`  submitted_song ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }
  console.log(`  ✓ ${count} submitted songs`);
  totalInserted += count;
}

// ── 8. SUBGROUPS ─────────────────────────────────────────────────────────────
async function migrateSubgroups() {
  console.log('\n[8/9] Migrating subgroups...');
  const docs = await readAll('subgroups');
  let count = 0;
  for (const doc of docs) {
    const d = doc.data();
    const orgId = str(d.zoneId || d.zone_id);
    if (!orgId) { console.warn(`  subgroup ${doc.id}: no zoneId, skipping`); continue; }
    try {
      await prisma.subgroup.upsert({
        where: { id: doc.id },
        create: {
          id: doc.id,
          organizationId: orgId,
          name: str(d.name) || 'Unnamed',
          description: str(d.description),
          type: str(d.type) || 'church',
          status: str(d.status) || 'active',
          coordinatorId: str(d.coordinatorId),
          coordinatorName: str(d.coordinatorName),
          estimatedMembers: Number(d.estimatedMembers || 0),
          createdAt: ts(d.createdAt) || new Date(),
          rawData: d,
        },
        update: {
          name: str(d.name) || 'Unnamed',
          status: str(d.status) || 'active',
          rawData: d,
        },
      });
      count++;
    } catch (e: any) {
      console.warn(`  subgroup ${doc.id}: ${e.message?.split('\n')[0]}`);
    }
  }
  console.log(`  ✓ ${count} subgroups`);
  totalInserted += count;
}

// ── 9. ANALYTICS (simplified) ────────────────────────────────────────────────
async function migrateAnalytics() {
  console.log('\n[9/9] Migrating analytics (simplified — activity_logs sample)...');
  // Just migrate a sample of activity_logs as AnalyticsEvents — not all 55k
  // We only take the last 500 to seed the analytics table with recent data
  const snap = await db.collection('activity_logs').orderBy('timestamp', 'desc').limit(500).get();
  let count = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    try {
      await prisma.analyticsEvent.upsert({
        where: { id: doc.id },
        create: { id: doc.id, rawData: d },
        update: { rawData: d },
      });
      count++;
    } catch (e: any) {
      // Silently skip analytics failures — non-critical
    }
  }
  console.log(`  ✓ ${count} analytics events (sampled)`);
  totalInserted += count;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Firebase → Prisma Migration ===');
  console.log('READ-ONLY from Firebase | WRITE to Prisma (upsert only, no deletes)\n');

  await migrateProfiles();
  await migrateMemberships();
  await migrateSongs();
  await migratePrograms();
  await migrateAttendance();
  await migrateCategories();
  await migrateSubmittedSongs();
  await migrateSubgroups();
  await migrateAnalytics();

  console.log(`\n=== Done — ${totalInserted} total records migrated ===`);
  await admin.app().delete();
  await pool.end();
}

main().catch((e) => {
  console.error('\nMigration failed:', e.message);
  process.exit(1);
});
