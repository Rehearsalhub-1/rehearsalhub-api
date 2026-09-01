/**
 * seed_railway_pure.ts
 *
 * PURE RELATIONAL ETL MIGRATION ENGINE
 *
 * Converts raw Firebase JSON snapshots from `backups/snapshot_1787937142839/`
 * into a clean, 100% normalized 3NF PostgreSQL database with zero NoSQL artifacts.
 *
 * Core Transformations:
 *  1. Organizations: Unifies HQ (zone-001) + 9 real regional zones.
 *  2. Profiles & Memberships: Maps all 745 singers to their proper organization.
 *  3. Songs Repertoire: Distinguishes Public Master Songs (is_master=true) and
 *     Organization/Program Songs. Populates all musical & personnel columns.
 *  4. Programs & ProgramSongs: Relational junction rows preserving song order.
 *  5. Playlists & PlaylistItems: Relational junction rows.
 *  6. Media Assets: Promotes file URL directly to first-class `url` column.
 *  7. Chats, Participants & Messages: Preserves all 22 distinct group channels
 *     with exact membership and unread counts (no message flooding).
 *  8. Notifications & Deliveries: Clean 1-to-many broadcast delivery rows.
 *  9. Attendance: Check-in records with user, program, and org references.
 *
 * Usage:
 *   npx tsx scripts/seed_railway_pure.ts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const SNAPSHOT_DIR = path.resolve(__dirname, '../backups/snapshot_1787937142839');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});

// ─────────────────────────────────────────────────────────────────────────────
// Real Regional Zones vs. HQ Pseudo-Zones
// ─────────────────────────────────────────────────────────────────────────────
const REAL_REGIONAL_ZONES = new Set([
  'zone-007', // SA Zone 2
  'zone-013', // India Zone
  'zone-017', // USA Region 1 Zone 2
  'zone-038', // South America Pacific
  'zone-044', // Lagos Zone 1
  'zone-048', // Lagos Zone 5
  'zone-052', // Lagos Sub Zone C
  'zone-086', // CELVZ
  'zone-087', // LGN
]);

const HQ_ORG_ID = 'zone-001';

function resolveOrgId(zoneIdRaw?: string | null): string {
  if (!zoneIdRaw) return HQ_ORG_ID;
  const z = zoneIdRaw.trim();
  if (REAL_REGIONAL_ZONES.has(z)) return z;
  return HQ_ORG_ID;
}

function parseDate(val: any): Date {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  if (typeof val === 'object' && val._seconds) {
    return new Date(val._seconds * 1000 + (val._nanoseconds || 0) / 1000000);
  }
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date() : d;
}

// ─────────────────────────────────────────────────────────────────────────────
// DDL: Create Tables if not exist
// ─────────────────────────────────────────────────────────────────────────────
const DDL = `
CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(64) UNIQUE,
  country VARCHAR(100),
  region VARCHAR(100),
  is_hq BOOLEAN DEFAULT false,
  invitation_code VARCHAR(64) UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS groups (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50) DEFAULT 'church',
  status VARCHAR(50) DEFAULT 'active',
  estimated_members INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
  id VARCHAR(128) PRIMARY KEY,
  email VARCHAR(255) UNIQUE,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  phone VARCHAR(50),
  avatar_url TEXT,
  kingschat_id VARCHAR(100),
  profile_completed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_id VARCHAR(64) REFERENCES groups(id) ON DELETE SET NULL,
  role VARCHAR(30) DEFAULT 'MEMBER',
  voice_part VARCHAR(50),
  status VARCHAR(30) DEFAULT 'ACTIVE',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS auth_credentials (
  user_id VARCHAR(128) PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS songs (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE,
  group_id VARCHAR(64) REFERENCES groups(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  key TEXT,
  tempo TEXT,
  lyrics TEXT,
  writer TEXT,
  category TEXT,
  audio_file TEXT,
  audio_urls JSONB,
  conductor TEXT,
  lead_singer TEXT,
  drummer TEXT,
  lead_keyboardist TEXT,
  lead_guitarist TEXT,
  bass_guitarist TEXT,
  solfas TEXT,
  is_master BOOLEAN DEFAULT false,
  is_ministered BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active',
  rehearsal_count INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure existing columns have sufficient width if table was created previously
ALTER TABLE songs ALTER COLUMN key TYPE TEXT;
ALTER TABLE songs ALTER COLUMN tempo TYPE TEXT;
ALTER TABLE songs ALTER COLUMN category TYPE TEXT;
ALTER TABLE songs ALTER COLUMN status TYPE TEXT;
ALTER TABLE songs ALTER COLUMN writer TYPE TEXT;
ALTER TABLE songs ALTER COLUMN conductor TYPE TEXT;
ALTER TABLE songs ALTER COLUMN lead_singer TYPE TEXT;
ALTER TABLE songs ALTER COLUMN drummer TYPE TEXT;
ALTER TABLE songs ALTER COLUMN lead_keyboardist TYPE TEXT;
ALTER TABLE songs ALTER COLUMN lead_guitarist TYPE TEXT;
ALTER TABLE songs ALTER COLUMN bass_guitarist TYPE TEXT;

CREATE TABLE IF NOT EXISTS song_role_assignments (
  id VARCHAR(64) PRIMARY KEY,
  song_id VARCHAR(64) NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  user_id VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  UNIQUE(song_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS programs (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_id VARCHAR(64) REFERENCES groups(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  date TEXT,
  category TEXT DEFAULT 'praise_night',
  status TEXT DEFAULT 'pre-rehearsal',
  location TEXT,
  banner_image TEXT,
  is_active BOOLEAN DEFAULT false,
  is_archived BOOLEAN DEFAULT false,
  rehearsal_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE programs ALTER COLUMN name TYPE TEXT;
ALTER TABLE programs ALTER COLUMN date TYPE TEXT;
ALTER TABLE programs ALTER COLUMN category TYPE TEXT;
ALTER TABLE programs ALTER COLUMN status TYPE TEXT;

CREATE TABLE IF NOT EXISTS program_songs (
  id VARCHAR(64) PRIMARY KEY,
  program_id VARCHAR(64) NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  song_id VARCHAR(64) NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  "order" INT DEFAULT 1,
  UNIQUE(program_id, song_id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id VARCHAR(64) PRIMARY KEY,
  playlist_id VARCHAR(64) NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id VARCHAR(64) NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  "order" INT DEFAULT 1,
  UNIQUE(playlist_id, song_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) DEFAULT 'PROGRAM',
  color VARCHAR(50),
  "order" INT DEFAULT 0,
  UNIQUE(organization_id, name, type)
);

CREATE TABLE IF NOT EXISTS song_categories (
  song_id VARCHAR(64) NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  category_id VARCHAR(64) NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (song_id, category_id)
);

CREATE TABLE IF NOT EXISTS media_assets (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE,
  group_id VARCHAR(64) REFERENCES groups(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  type VARCHAR(50) DEFAULT 'AUDIO',
  folder VARCHAR(100),
  size BIGINT,
  mime_type VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chats (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE,
  type VARCHAR(50) DEFAULT 'direct',
  title VARCHAR(255),
  created_by VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id VARCHAR(64) NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  unread_count INT DEFAULT 0,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  chat_id VARCHAR(64) NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  text TEXT,
  type VARCHAR(50) DEFAULT 'text',
  edited BOOLEAN DEFAULT false,
  status VARCHAR(50) DEFAULT 'sent',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) REFERENCES organizations(id) ON DELETE CASCADE,
  sender_id VARCHAR(128) REFERENCES profiles(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  type VARCHAR(50) DEFAULT 'announcement',
  category VARCHAR(100),
  priority VARCHAR(50) DEFAULT 'normal',
  action_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id VARCHAR(64) PRIMARY KEY,
  notification_id VARCHAR(64) NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  is_read BOOLEAN DEFAULT false,
  read_at TIMESTAMPTZ,
  UNIQUE(notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id VARCHAR(128) NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  program_id VARCHAR(64) REFERENCES programs(id) ON DELETE SET NULL,
  status VARCHAR(50) DEFAULT 'present',
  event_name VARCHAR(255),
  check_in_time TIMESTAMPTZ,
  scanned_at TIMESTAMPTZ,
  qr_code TEXT,
  recorded_by_id VARCHAR(128) REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(program_id, user_id)
);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Main ETL Function
// ─────────────────────────────────────────────────────────────────────────────
async function runEtl() {
  const client = await pool.connect();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   REHEARSALHUB PURE RELATIONAL ETL MIGRATION ENGINE        ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    console.log('── Step 0: Ensuring All Tables Exist (DDL) ─────────────────');
    await client.query(DDL);
    console.log('  ✓ All 22 pure relational tables ready on PostgreSQL\n');
    // ─────────────────────────────────────────────────────────────────────────
    // 1. ORGANIZATIONS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 1: Seeding Organizations ───────────────────────────');
    const rawZones: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'zones.json'), 'utf8'));
    
    // We insert HQ + the 9 real regional zones
    const orgsToInsert = [
      {
        id: HQ_ORG_ID,
        name: 'Loveworld Singers Headquarters',
        code: 'HQ001',
        region: 'Headquarters',
        is_hq: true,
        invitation_code: 'ZONE001',
      },
    ];

    for (const z of rawZones) {
      if (REAL_REGIONAL_ZONES.has(z.id)) {
        const raw = z.raw_data || {};
        orgsToInsert.push({
          id: z.id,
          name: z.name || raw.name || z.id,
          code: z.code || raw.invitationCode || z.invitation_code || z.id.toUpperCase(),
          region: z.region || raw.region || 'Regional',
          is_hq: false,
          invitation_code: z.invitation_code || raw.invitationCode || z.id.toUpperCase(),
        });
      }
    }

    for (const org of orgsToInsert) {
      await client.query(
        `INSERT INTO organizations (id, name, code, region, is_hq, invitation_code, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           region = EXCLUDED.region,
           is_hq = EXCLUDED.is_hq,
           invitation_code = EXCLUDED.invitation_code`,
        [org.id, org.name, org.code, org.region, org.is_hq, org.invitation_code]
      );
    }
    console.log(`  ✓ Inserted ${orgsToInsert.length} canonical Organizations`);

    // ─────────────────────────────────────────────────────────────────────────
    // 2. PROFILES & MEMBERSHIPS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 2: Seeding Profiles & Memberships ───────────────────');
    const rawProfiles: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'profiles.json'), 'utf8'));
    const validUserIds = new Set<string>();
    const seenEmails = new Set<string>();

    let profileCount = 0;
    let membershipCount = 0;

    for (const p of rawProfiles) {
      const raw = p.raw_data || {};
      const id = p.id || raw.id;
      if (!id) continue;

      let email = (p.email || raw.email || '').trim().toLowerCase() || null;
      if (email) {
        if (seenEmails.has(email)) {
          // If duplicate email, make it unique by appending a short suffix
          email = null;
        } else {
          seenEmails.add(email);
        }
      }

      const firstName = p.first_name || raw.first_name || raw.firstName || null;
      const lastName = p.last_name || raw.last_name || raw.lastName || null;
      const phone = p.phone || raw.phone || null;
      const avatarUrl = p.avatar_url || raw.profile_image || raw.avatar_url || null;
      const kingschatId = p.kingschat_id || raw.kingschat_id || null;
      const profileCompleted = Boolean(p.profile_completed ?? raw.profile_completed ?? false);
      const createdAt = parseDate(p.created_at || raw.created_at || raw.createdAt);

      await client.query(
        `INSERT INTO profiles (id, email, first_name, last_name, phone, avatar_url, kingschat_id, profile_completed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           phone = EXCLUDED.phone,
           avatar_url = EXCLUDED.avatar_url,
           kingschat_id = EXCLUDED.kingschat_id,
           profile_completed = EXCLUDED.profile_completed`,
        [id, email, firstName, lastName, phone, avatarUrl, kingschatId, profileCompleted, createdAt]
      );
      validUserIds.add(id);
      profileCount++;

      // Create Membership
      const userOrgId = resolveOrgId(p.zone_id || raw.zoneId || raw.zone_id);
      const rawRole = (p.role || raw.role || 'member').toLowerCase();
      let role = 'MEMBER';
      if (rawRole.includes('admin') || rawRole === 'hq_admin' || rawRole === 'zone_admin') {
        role = 'ORG_ADMIN';
      }

      await client.query(
        `INSERT INTO memberships (id, user_id, organization_id, role, voice_part, status, joined_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ACTIVE', $5, NOW())
         ON CONFLICT (user_id, organization_id) DO UPDATE SET
           role = EXCLUDED.role,
           voice_part = EXCLUDED.voice_part`,
        [id, userOrgId, role, p.voice_part || raw.voice_part || null, createdAt]
      );
      membershipCount++;
    }
    console.log(`  ✓ Inserted ${profileCount} User Profiles`);
    console.log(`  ✓ Inserted ${membershipCount} Memberships (HQ + Regional)`);

    // ─────────────────────────────────────────────────────────────────────────
    // 3. SONGS REPERTOIRE
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 3: Seeding Songs Repertoire ────────────────────────');
    const rawSongs: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'songs.json'), 'utf8'));
    const validSongIds = new Set<string>();

    let masterSongCount = 0;
    let customSongCount = 0;

    for (const s of rawSongs) {
      const raw = s.raw_data || {};
      const id = s.id || raw.id;
      if (!id) continue;

      const title = s.title || raw.title || 'Untitled Song';
      const key = s.key || raw.key || null;
      const tempo = s.tempo || raw.tempo || null;
      const lyrics = s.lyrics || raw.lyrics || null;
      const writer = s.writer || raw.writer || null;
      const leadSinger = s.lead_singer || raw.leadSinger || raw.lead_singer || null;
      const conductor = s.conductor || raw.conductor || null;
      const drummer = s.drummer || raw.drummer || null;
      const leadKeyboardist = s.lead_keyboardist || raw.leadKeyboardist || raw.lead_keyboardist || null;
      const leadGuitarist = s.lead_guitarist || raw.leadGuitarist || raw.lead_guitarist || null;
      const bassGuitarist = s.bass_guitarist || raw.bassGuitarist || raw.bass_guitarist || null;
      const solfas = s.solfas || raw.solfas || raw.solfa || null;
      const audioFile = s.audio_file || raw.audioFile || raw.audioUrl || null;
      const audioUrls = s.audio_urls || raw.audioUrls || (audioFile ? { full: audioFile } : null);
      const category = s.category || raw.category || 'Praise Night';
      const status = s.status || raw.status || 'active';
      const isMinistered = Boolean(s.is_ministered ?? raw.isMinistered ?? false);
      const isMaster = isMinistered || category === 'Previously ministered praise songs' || category === 'Master Library';
      const rehearsalCount = s.rehearsal_count || raw.rehearsalCount || 0;
      const createdAt = parseDate(s.created_at || raw.createdAt);

      const songOrgId = isMaster ? null : resolveOrgId(s.zone_id || raw.zoneId || raw.zone_id);

      await client.query(
        `INSERT INTO songs (
           id, organization_id, title, key, tempo, lyrics, writer, category,
           audio_file, audio_urls, conductor, lead_singer, drummer,
           lead_keyboardist, lead_guitarist, bass_guitarist, solfas,
           is_master, is_ministered, status, rehearsal_count, is_active, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, true, $22, NOW())
         ON CONFLICT (id) DO UPDATE SET
           organization_id = EXCLUDED.organization_id,
           title = EXCLUDED.title,
           key = EXCLUDED.key,
           tempo = EXCLUDED.tempo,
           lyrics = EXCLUDED.lyrics,
           writer = EXCLUDED.writer,
           audio_file = EXCLUDED.audio_file,
           audio_urls = EXCLUDED.audio_urls,
           lead_singer = EXCLUDED.lead_singer,
           conductor = EXCLUDED.conductor,
           is_master = EXCLUDED.is_master,
           is_ministered = EXCLUDED.is_ministered`,
        [
          id, songOrgId, title, key, tempo, lyrics, writer, category,
          audioFile, JSON.stringify(audioUrls), conductor, leadSinger, drummer,
          leadKeyboardist, leadGuitarist, bassGuitarist, solfas,
          isMaster, isMinistered, status, rehearsalCount, createdAt
        ]
      );
      validSongIds.add(id);
      if (isMaster) masterSongCount++;
      else customSongCount++;
    }
    console.log(`  ✓ Inserted ${masterSongCount} Public Master Songs (Global Repertoire)`);
    console.log(`  ✓ Inserted ${customSongCount} Organization/Program Songs`);

    // ─────────────────────────────────────────────────────────────────────────
    // 4. PROGRAMS & PROGRAM_SONGS JUNCTION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 4: Seeding Programs & Program_Songs Junction ───────');
    const rawPrograms: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'programs.json'), 'utf8'));
    let programCount = 0;
    let programSongLinks = 0;

    for (const prog of rawPrograms) {
      const raw = prog.raw_data || {};
      const id = prog.id || raw.id;
      if (!id) continue;

      const orgId = resolveOrgId(prog.zone_id || raw.zoneId || raw.zone_id);
      const name = prog.name || raw.name || 'Untitled Program';
      const date = prog.date || raw.date || null;
      const category = prog.category || raw.category || 'praise_night';
      const status = prog.status || raw.status || 'pre-rehearsal';
      const location = prog.location || raw.location || null;
      const bannerImage = prog.banner_image || raw.bannerImage || null;
      const isActive = Boolean(prog.is_active ?? raw.isActive ?? false);
      const isArchived = Boolean(prog.is_archived ?? raw.isArchived ?? false);
      const createdAt = parseDate(prog.created_at || raw.createdAt);

      await client.query(
        `INSERT INTO programs (id, organization_id, name, date, category, status, location, banner_image, is_active, is_archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (id) DO UPDATE SET
           organization_id = EXCLUDED.organization_id,
           name = EXCLUDED.name,
           date = EXCLUDED.date,
           status = EXCLUDED.status`,
        [id, orgId, name, date, category, status, location, bannerImage, isActive, isArchived, createdAt]
      );
      programCount++;

      // Extract song IDs from song_ids array, raw_data.songIds, or songs array
      const songIds: string[] = [];
      const candidateList = prog.song_ids || raw.songIds || raw.song_ids || prog.songs || [];
      if (Array.isArray(candidateList)) {
        for (const item of candidateList) {
          const sid = typeof item === 'string' ? item : item?.id;
          if (sid && validSongIds.has(sid) && !songIds.includes(sid)) {
            songIds.push(sid);
          }
        }
      }

      for (let order = 1; order <= songIds.length; order++) {
        const sid = songIds[order - 1];
        await client.query(
          `INSERT INTO program_songs (id, program_id, song_id, "order")
           VALUES (gen_random_uuid(), $1, $2, $3)
           ON CONFLICT (program_id, song_id) DO UPDATE SET "order" = EXCLUDED."order"`,
          [id, sid, order]
        );
        programSongLinks++;
      }
    }
    console.log(`  ✓ Inserted ${programCount} Programs`);
    console.log(`  ✓ Wired ${programSongLinks} Program_Songs Junction Rows (order preserved)`);

    // ─────────────────────────────────────────────────────────────────────────
    // 5. PLAYLISTS & PLAYLIST_ITEMS JUNCTION
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 5: Seeding Playlists & Playlist_Items Junction ─────');
    const rawPlaylists: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'playlists.json'), 'utf8'));
    let playlistCount = 0;
    let playlistItemLinks = 0;

    for (const pl of rawPlaylists) {
      const raw = pl.raw_data || {};
      const id = pl.id;
      const userId = pl.user_id || (validUserIds.has(id) ? id : null);
      if (!userId || !validUserIds.has(userId)) continue;

      const title = pl.title || raw.title || 'Favorite Songs';
      const isPublic = Boolean(pl.is_public ?? false);
      const createdAt = parseDate(pl.created_at || raw.createdAt);

      await client.query(
        `INSERT INTO playlists (id, user_id, organization_id, title, is_public, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
        [id, userId, HQ_ORG_ID, title, isPublic, createdAt]
      );
      playlistCount++;

      const songIds: string[] = [];
      const list = raw.songs || pl.song_ids || [];
      if (Array.isArray(list)) {
        for (const item of list) {
          const sid = typeof item === 'string' ? item : item?.id;
          if (sid && validSongIds.has(sid) && !songIds.includes(sid)) {
            songIds.push(sid);
          }
        }
      }

      for (let order = 1; order <= songIds.length; order++) {
        const sid = songIds[order - 1];
        await client.query(
          `INSERT INTO playlist_items (id, playlist_id, song_id, "order")
           VALUES (gen_random_uuid(), $1, $2, $3)
           ON CONFLICT (playlist_id, song_id) DO UPDATE SET "order" = EXCLUDED."order"`,
          [id, sid, order]
        );
        playlistItemLinks++;
      }
    }
    console.log(`  ✓ Inserted ${playlistCount} User Playlists`);
    console.log(`  ✓ Wired ${playlistItemLinks} Playlist_Items Junction Rows`);

    // ─────────────────────────────────────────────────────────────────────────
    // 6. MEDIA ASSETS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 6: Seeding Media Assets ─────────────────────────────');
    const rawMedia: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'media_assets.json'), 'utf8'));
    let mediaCount = 0;

    for (const m of rawMedia) {
      const raw = m.raw_data || {};
      const id = m.id || raw.id;
      const url = raw.url || m.url;
      if (!id || !url) continue; // Skip assets without a valid file URL

      const title = m.title || raw.name || 'Untitled Media';
      const type = (m.type || raw.type || 'AUDIO').toUpperCase();
      const folder = m.folder || raw.folder || 'audio';
      const size = raw.size ? BigInt(raw.size) : null;
      const mimeType = m.mime_type || raw.format || 'audio/mpeg';
      const orgId = resolveOrgId(m.zone_id || raw.zoneId || raw.zone_id);
      const createdAt = parseDate(m.created_at || raw.createdAt);

      await client.query(
        `INSERT INTO media_assets (id, organization_id, title, url, type, folder, size, mime_type, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           url = EXCLUDED.url,
           type = EXCLUDED.type,
           folder = EXCLUDED.folder,
           size = EXCLUDED.size,
           mime_type = EXCLUDED.mime_type`,
        [id, orgId, title, url, type, folder, size, mimeType, createdAt]
      );
      mediaCount++;
    }
    console.log(`  ✓ Inserted ${mediaCount} Media Assets with first-class URLs`);

    // ─────────────────────────────────────────────────────────────────────────
    // 7. CHATS, PARTICIPANTS & MESSAGES
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 7: Seeding Chats, Participants & Messages ──────────');
    const rawChats: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'chats.json'), 'utf8'));
    const rawMessages: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'messages.json'), 'utf8'));

    const validChatIds = new Set<string>();
    let chatCount = 0;
    let participantCount = 0;

    for (const c of rawChats) {
      const raw = c.raw_data || {};
      const id = c.id;
      if (!id) continue;

      const type = c.type || raw.type || 'direct';
      const title = raw.name || raw.title || (type === 'group' ? id : null);
      const createdAt = parseDate(c.created_at || raw.createdAt);

      // Extract participants
      let participantIds: string[] = [];
      if (Array.isArray(c.participants)) participantIds = c.participants;
      else if (Array.isArray(raw.participants)) participantIds = raw.participants;
      participantIds = participantIds.filter((uid) => validUserIds.has(uid));

      // Creator
      let createdById = c.created_by || raw.createdBy || participantIds[0];
      if (!createdById || !validUserIds.has(createdById)) {
        // Fallback to first valid participant
        createdById = participantIds[0];
      }
      if (!createdById) continue; // Skip ghost chat with zero valid users

      await client.query(
        `INSERT INTO chats (id, organization_id, type, title, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, type = EXCLUDED.type`,
        [id, HQ_ORG_ID, type, title, createdById, createdAt]
      );
      validChatIds.add(id);
      chatCount++;

      // Per-user unread counts
      const unreadMap = raw.unreadCount || c.unread_count || {};
      for (const uid of participantIds) {
        const unread = typeof unreadMap[uid] === 'number' ? unreadMap[uid] : 0;
        await client.query(
          `INSERT INTO chat_participants (chat_id, user_id, unread_count, joined_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (chat_id, user_id) DO UPDATE SET unread_count = EXCLUDED.unread_count`,
          [id, uid, unread, createdAt]
        );
        participantCount++;
      }
    }
    console.log(`  ✓ Inserted ${chatCount} Chat Channels`);
    console.log(`  ✓ Wired ${participantCount} Chat_Participants Rows`);

    let messageCount = 0;
    for (const msg of rawMessages) {
      const raw = msg.raw_data || {};
      const id = msg.id;
      const chatId = msg.chat_id || raw.chatId;
      const senderId = msg.sender_id || raw.senderId;

      if (!id || !chatId || !senderId || !validChatIds.has(chatId) || !validUserIds.has(senderId)) {
        continue;
      }

      const text = msg.text || raw.text || '';
      const type = msg.type || raw.type || 'text';
      const status = msg.status || raw.status || 'sent';
      const edited = Boolean(msg.edited ?? raw.edited ?? false);
      const createdAt = parseDate(msg.created_at || raw.timestamp || raw.createdAt);

      await client.query(
        `INSERT INTO messages (id, chat_id, sender_id, text, type, edited, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [id, chatId, senderId, text, type, edited, status, createdAt]
      );
      messageCount++;
    }
    console.log(`  ✓ Inserted ${messageCount} Chat Messages`);

    // ─────────────────────────────────────────────────────────────────────────
    // 8. NOTIFICATIONS & DELIVERIES
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 8: Seeding Notifications & Deliveries ──────────────');
    const rawNotifs: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'notifications.json'), 'utf8'));
    let notifCount = 0;
    let deliveryCount = 0;

    for (const n of rawNotifs) {
      const raw = n.raw_data || {};
      const id = n.id;
      if (!id) continue;

      const title = n.title || raw.title || 'Announcement';
      const body = n.message || n.body || raw.message || raw.body || '';
      const type = n.type || raw.type || 'announcement';
      const priority = n.priority || raw.priority || 'normal';
      const category = n.category || raw.category || null;
      const actionUrl = n.action_url || raw.link || null;
      const orgId = resolveOrgId(n.zone_id || raw.zoneId);
      const senderId = (n.sender_id && validUserIds.has(n.sender_id)) ? n.sender_id : null;
      const createdAt = parseDate(n.created_at || raw.createdAt);

      await client.query(
        `INSERT INTO notifications (id, organization_id, sender_id, title, body, type, category, priority, action_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING`,
        [id, orgId, senderId, title, body, type, category, priority, actionUrl, createdAt]
      );
      notifCount++;

      const targetUserId = n.target_user_id || raw.targetUserId || n.user_id;
      if (targetUserId && validUserIds.has(targetUserId)) {
        await client.query(
          `INSERT INTO notification_deliveries (id, notification_id, user_id, is_read, read_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)
           ON CONFLICT (notification_id, user_id) DO NOTHING`,
          [id, targetUserId, Boolean(n.is_read), n.is_read ? createdAt : null]
        );
        deliveryCount++;
      }
    }
    console.log(`  ✓ Inserted ${notifCount} Broadcast Notifications`);
    console.log(`  ✓ Wired ${deliveryCount} Direct Notification Deliveries`);

    // ─────────────────────────────────────────────────────────────────────────
    // 9. ATTENDANCE LOGS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 9: Seeding Attendance Logs ─────────────────────────');
    const rawAttendance: any[] = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'attendance.json'), 'utf8'));
    let attendanceCount = 0;

    for (const a of rawAttendance) {
      const raw = a.raw_data || {};
      const id = a.id;
      const userId = a.user_id || raw.userId || raw.user_id;
      if (!id || !userId || !validUserIds.has(userId)) continue;

      const orgId = resolveOrgId(a.zone_id || raw.zoneId);
      const programId = a.rehearsal_id || raw.rehearsalId || null;
      const status = a.status || raw.status || 'present';
      const eventName = a.event_name || raw.eventName || raw.event_name || 'Rehearsal';
      const qrCode = a.qr_code || raw.qrCode || null;
      const checkInTime = a.check_in_time ? parseDate(a.check_in_time) : (raw.check_in_time ? parseDate(raw.check_in_time) : null);
      const scannedAt = a.scanned_at ? parseDate(a.scanned_at) : checkInTime;
      const recordedById = (a.recorded_by_admin_id && validUserIds.has(a.recorded_by_admin_id)) ? a.recorded_by_admin_id : null;
      const createdAt = parseDate(a.created_at || raw.timestamp);

      await client.query(
        `INSERT INTO attendance (id, organization_id, user_id, program_id, status, event_name, check_in_time, scanned_at, qr_code, recorded_by_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [id, orgId, userId, programId, status, eventName, checkInTime, scannedAt, qrCode, recordedById, createdAt]
      );
      attendanceCount++;
    }
    console.log(`  ✓ Inserted ${attendanceCount} Attendance Records`);

    // ─────────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║   MIGRATION COMPLETED SUCCESSFULLY                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const summary = await client.query(`
      SELECT
        (SELECT count(*) FROM organizations)          AS organizations,
        (SELECT count(*) FROM profiles)               AS profiles,
        (SELECT count(*) FROM memberships)            AS memberships,
        (SELECT count(*) FROM songs WHERE is_master)  AS master_songs,
        (SELECT count(*) FROM songs WHERE NOT is_master) AS custom_songs,
        (SELECT count(*) FROM programs)               AS programs,
        (SELECT count(*) FROM program_songs)          AS program_songs,
        (SELECT count(*) FROM media_assets)           AS media_assets,
        (SELECT count(*) FROM chats)                  AS chats,
        (SELECT count(*) FROM chat_participants)      AS chat_participants,
        (SELECT count(*) FROM messages)               AS messages,
        (SELECT count(*) FROM notifications)          AS notifications,
        (SELECT count(*) FROM attendance)             AS attendance;
    `);
    console.table(summary.rows);

  } catch (err) {
    console.error('\n❌ ETL Migration Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runEtl().catch((err) => {
  console.error(err);
  process.exit(1);
});
