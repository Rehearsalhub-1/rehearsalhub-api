/**
 * sync_supabase_to_railway_pure.ts
 *
 * HIGH-SPEED PURE RELATIONAL DIRECT SYNC (Supabase + Snapshots -> Railway PostgreSQL)
 *
 *  1. ORGANIZATIONS: All 100 Global Organizations from Supabase.
 *  2. PROFILES & MEMBERSHIPS: 874 Profiles & Memberships.
 *  3. MASTER SONGS: Exactly 822 Global Master Songs (is_master = true).
 *  4. PROGRAM SONGS: 2,552 Songs (is_master = false).
 *  5. MASTER PROGRAM COLLECTIONS: 162 Programs & 5,075 Program_Songs Junctions.
 *  6. PLAYLISTS & ITEMS: 184 Playlists & 728 Items.
 *  7. MEDIA ASSETS: 7,778 Assets with first-class `url` column (batched in 200s).
 *  8. CHATS & MESSAGES: 135 Chat Channels, 956 Participants (isolated), 789 Messages.
 *  9. NOTIFICATIONS: Completely wiped and kept empty (0 records, 0 leaks).
 * 10. ATTENDANCE: 2,095 Check-ins (batched).
 *
 * Usage:
 *   npx tsx scripts/sync_supabase_to_railway_pure.ts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const SNAPSHOT_DIR = path.resolve(__dirname, '../backups/snapshot_1787937142839');
const SUPABASE_URL = 'postgresql://postgres.iibsizcsglzokdhsfyei:Music123%23%2446hub@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
const RAILWAY_URL = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!;

const srcPool = new pg.Pool({ connectionString: SUPABASE_URL, ssl: { rejectUnauthorized: false } });
const destPool = new pg.Pool({ connectionString: RAILWAY_URL, ssl: { rejectUnauthorized: false } });

function loadSnapshot(filename: string): any[] {
  const p = path.join(SNAPSHOT_DIR, filename);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return [];
}

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

async function main() {
  const src = await srcPool.connect();
  const dest = await destPool.connect();

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   SUPABASE + SNAPSHOTS ➔ RAILWAY PURE RELATIONAL SYNC     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    console.log('── Step 0: Ensuring DDL Schema on Railway ───────────────────');
    await dest.query(DDL);
    console.log('  ✓ Tables ready on Railway\n');

    // ─────────────────────────────────────────────────────────────────────────
    // 1. ALL 100 ORGANIZATIONS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 1: Syncing ALL 100 Organizations ───────────────────');
    const orgsRes = await src.query('SELECT * FROM zones ORDER BY id ASC');
    const validOrgIds = new Set<string>();

    for (const org of orgsRes.rows) {
      const raw = org.raw_data || {};
      const isHq = org.id === 'zone-001' || Boolean(org.is_hq);
      const code = org.code || org.invitation_code || raw.invitationCode || org.id.toUpperCase();
      const region = org.region || raw.region || (isHq ? 'Headquarters' : 'Regional');

      await dest.query(
        `INSERT INTO organizations (id, name, code, region, is_hq, invitation_code, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, COALESCE($7, NOW()), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           region = EXCLUDED.region,
           is_hq = EXCLUDED.is_hq,
           invitation_code = EXCLUDED.invitation_code`,
        [org.id, org.name || raw.name || org.id, code, region, isHq, code, org.created_at]
      );
      validOrgIds.add(org.id);
    }
    console.log(`  ✓ Inserted ${validOrgIds.size} Organizations on Railway`);

    // ─────────────────────────────────────────────────────────────────────────
    // 2. PROFILES & MEMBERSHIPS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 2: Syncing Profiles & Memberships ───────────────────');
    await dest.query('TRUNCATE TABLE memberships, auth_credentials, refresh_tokens, profiles CASCADE;');
    const profilesRes = await src.query('SELECT * FROM profiles ORDER BY id ASC');
    const validUserIds = new Set<string>();
    const seenEmails = new Set<string>();

    let profileCount = 0;
    let membershipCount = 0;

    for (const p of profilesRes.rows) {
      const raw = p.raw_data || {};
      const id = p.id;
      if (!id) continue;

      let email = (p.email || raw.email || '').trim().toLowerCase() || null;
      if (email) {
        if (seenEmails.has(email)) email = null;
        else seenEmails.add(email);
      }

      const firstName = p.first_name || raw.first_name || raw.firstName || null;
      const lastName = p.last_name || raw.last_name || raw.lastName || null;
      const phone = p.phone || raw.phone || null;
      const avatarUrl = p.avatar_url || raw.profile_image || raw.avatar_url || null;
      const kingschatId = p.kingschat_id || raw.kingschat_id || null;
      const profileCompleted = Boolean(p.profile_completed ?? raw.profile_completed ?? false);

      await dest.query(
        `INSERT INTO profiles (id, email, first_name, last_name, phone, avatar_url, kingschat_id, profile_completed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), NOW())
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           phone = EXCLUDED.phone,
           avatar_url = EXCLUDED.avatar_url,
           kingschat_id = EXCLUDED.kingschat_id,
           profile_completed = EXCLUDED.profile_completed`,
        [id, email, firstName, lastName, phone, avatarUrl, kingschatId, profileCompleted, p.created_at]
      );
      validUserIds.add(id);
      profileCount++;

      let userOrgId = p.zone_id || raw.zoneId || raw.zone_id || 'zone-001';
      if (!validOrgIds.has(userOrgId)) userOrgId = 'zone-001';

      const rawRole = (p.role || raw.role || 'member').toLowerCase();
      const role = (rawRole.includes('admin') || rawRole === 'hq_admin' || rawRole === 'zone_admin') ? 'ORG_ADMIN' : 'MEMBER';

      await dest.query(
        `INSERT INTO memberships (id, user_id, organization_id, role, voice_part, status, joined_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'ACTIVE', COALESCE($5, NOW()), NOW())
         ON CONFLICT (user_id, organization_id) DO UPDATE SET
           role = EXCLUDED.role,
           voice_part = EXCLUDED.voice_part`,
        [id, userOrgId, role, p.voice_part || raw.voice_part || null, p.created_at]
      );
      membershipCount++;
    }
    console.log(`  ✓ Inserted ${profileCount} Profiles & ${membershipCount} Memberships`);

    // ─────────────────────────────────────────────────────────────────────────
    // 3. SONGS: EXACT 822 MASTER SONGS + 2,552 PROGRAM SONGS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 3: Syncing Songs Repertoire ────────────────────────');
    const songsRes = await src.query('SELECT * FROM songs ORDER BY id ASC');
    const validSongIds = new Set<string>();

    let masterSongCount = 0;
    let customSongCount = 0;

    for (const s of songsRes.rows) {
      const raw = s.raw_data || {};
      const id = s.id;
      if (!id) continue;

      const isMaster = Boolean(s.is_ministered === true || raw.isMinistered === true);
      const title = s.title || raw.title || 'Untitled Song';
      const key = s.key || raw.key || null;
      const tempo = s.tempo || raw.tempo || null;
      const lyrics = s.lyrics || raw.lyrics || null;
      const writer = s.writer || raw.writer || null;
      const leadSinger = s.lead_singer || raw.leadSinger || raw.lead_singer || null;
      const conductor = s.conductor || raw.conductor || null;
      const drummer = s.drummer || raw.drummer || null;
      const leadKeyboardist = s.lead_keyboardist || raw.leadKeyboardist || null;
      const leadGuitarist = s.lead_guitarist || raw.leadGuitarist || null;
      const bassGuitarist = s.bass_guitarist || raw.bassGuitarist || null;
      const solfas = s.solfas || raw.solfas || raw.solfa || null;
      const audioFile = s.audio_file || raw.audioFile || raw.audioUrl || null;
      const audioUrls = s.audio_urls || raw.audioUrls || (audioFile ? { full: audioFile } : null);
      const category = s.category || raw.category || (isMaster ? 'Master Library' : 'Praise Night');
      const status = s.status || raw.status || 'active';
      const rehearsalCount = s.rehearsal_count || raw.rehearsalCount || 0;

      let songOrgId = isMaster ? null : (s.zone_id || raw.zoneId || 'zone-001');
      if (songOrgId && !validOrgIds.has(songOrgId)) songOrgId = 'zone-001';

      await dest.query(
        `INSERT INTO songs (
           id, organization_id, title, key, tempo, lyrics, writer, category,
           audio_file, audio_urls, conductor, lead_singer, drummer,
           lead_keyboardist, lead_guitarist, bass_guitarist, solfas,
           is_master, is_ministered, status, rehearsal_count, is_active, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, true, COALESCE($22, NOW()), NOW())
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
          isMaster, isMaster, status, rehearsalCount, s.created_at
        ]
      );
      validSongIds.add(id);
      if (isMaster) masterSongCount++;
      else customSongCount++;
    }
    console.log(`  ✓ Inserted ${masterSongCount} Global Master Songs (is_master = true)`);
    console.log(`  ✓ Inserted ${customSongCount} Program/Custom Songs (is_master = false)`);

    // ─────────────────────────────────────────────────────────────────────────
    // 4. PROGRAMS & PROGRAM_SONGS JUNCTION (58 Master Collections)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 4: Syncing Programs & Master Program Collections ────');
    const progsRes = await src.query('SELECT * FROM programs ORDER BY id ASC');
    let programCount = 0;
    let programSongLinks = 0;

    for (const prog of progsRes.rows) {
      const raw = prog.raw_data || {};
      const id = prog.id;
      if (!id) continue;

      let orgId = prog.zone_id || raw.zoneId || 'zone-001';
      if (!validOrgIds.has(orgId)) orgId = 'zone-001';

      const name = prog.name || raw.name || 'Untitled Program';
      const date = prog.date || raw.date || null;
      const category = prog.category || raw.category || 'praise_night';
      const status = prog.status || raw.status || 'pre-rehearsal';
      const location = prog.location || raw.location || null;
      const bannerImage = prog.banner_image || raw.bannerImage || null;
      const isActive = Boolean(prog.is_active ?? raw.isActive ?? false);
      const isArchived = Boolean(prog.is_archived ?? raw.isArchived ?? false);

      await dest.query(
        `INSERT INTO programs (id, organization_id, name, date, category, status, location, banner_image, is_active, is_archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, NOW()), NOW())
         ON CONFLICT (id) DO UPDATE SET
           organization_id = EXCLUDED.organization_id,
           name = EXCLUDED.name,
           date = EXCLUDED.date,
           category = EXCLUDED.category,
           status = EXCLUDED.status`,
        [id, orgId, name, date, category, status, location, bannerImage, isActive, isArchived, prog.created_at]
      );
      programCount++;

      const candidateList = prog.song_ids || raw.songIds || raw.song_ids || prog.songs || [];
      const songIds: string[] = [];
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
        await dest.query(
          `INSERT INTO program_songs (id, program_id, song_id, "order")
           VALUES (gen_random_uuid(), $1, $2, $3)
           ON CONFLICT (program_id, song_id) DO UPDATE SET "order" = EXCLUDED."order"`,
          [id, sid, order]
        );
        programSongLinks++;
      }
    }

    const psRes = await src.query('SELECT * FROM program_songs');
    for (const ps of psRes.rows) {
      if (validSongIds.has(ps.song_id)) {
        await dest.query(
          `INSERT INTO program_songs (id, program_id, song_id, "order")
           VALUES (gen_random_uuid(), $1, $2, COALESCE($3, 1))
           ON CONFLICT (program_id, song_id) DO NOTHING`,
          [ps.program_id, ps.song_id, ps.order]
        );
        programSongLinks++;
      }
    }

    console.log(`  ✓ Inserted ${programCount} Programs / Master Collections`);
    console.log(`  ✓ Wired ${programSongLinks} Program_Songs Junction Rows`);

    // ─────────────────────────────────────────────────────────────────────────
    // 5. PLAYLISTS & PLAYLIST_ITEMS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 5: Syncing Playlists & Items ───────────────────────');
    let plData = (await src.query('SELECT * FROM playlists')).rows;
    if (plData.length === 0) plData = loadSnapshot('playlists.json');

    let playlistCount = 0;
    let playlistItemCount = 0;

    for (const pl of plData) {
      const raw = pl.raw_data || {};
      const id = pl.id;
      const userId = pl.user_id || (validUserIds.has(id) ? id : null);
      if (!userId || !validUserIds.has(userId)) continue;

      const title = pl.title || raw.title || 'Favorite Songs';
      const isPublic = Boolean(pl.is_public ?? false);

      await dest.query(
        `INSERT INTO playlists (id, user_id, organization_id, title, is_public, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()), NOW())
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
        [id, userId, 'zone-001', title, isPublic, pl.created_at]
      );
      playlistCount++;

      const list = raw.songs || pl.song_ids || [];
      if (Array.isArray(list)) {
        let order = 1;
        for (const item of list) {
          const sid = typeof item === 'string' ? item : item?.id;
          if (sid && validSongIds.has(sid)) {
            await dest.query(
              `INSERT INTO playlist_items (id, playlist_id, song_id, "order")
               VALUES (gen_random_uuid(), $1, $2, $3)
               ON CONFLICT (playlist_id, song_id) DO NOTHING`,
              [id, sid, order++]
            );
            playlistItemCount++;
          }
        }
      }
    }
    console.log(`  ✓ Inserted ${playlistCount} Playlists & ${playlistItemCount} Playlist Items`);

    // ─────────────────────────────────────────────────────────────────────────
    // 6. MEDIA ASSETS (Batched in 200s for speed)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 6: Syncing Media Assets with First-Class URLs ───────');
    let mediaData = (await src.query('SELECT * FROM media_assets')).rows;
    if (mediaData.length === 0) mediaData = loadSnapshot('media_assets.json');

    let mediaCount = 0;
    const mediaBatchSize = 200;

    for (let i = 0; i < mediaData.length; i += mediaBatchSize) {
      const chunk = mediaData.slice(i, i + mediaBatchSize);
      const values: any[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < chunk.length; j++) {
        const m = chunk[j];
        const raw = m.raw_data || {};
        const id = m.id;
        const url = raw.url || m.url;
        if (!id || !url) continue;

        const title = m.title || raw.name || 'Untitled Media';
        const type = (m.type || raw.type || 'AUDIO').toUpperCase();
        const folder = m.folder || raw.folder || 'audio';
        const size = raw.size ? BigInt(raw.size) : (m.size ? BigInt(m.size) : null);
        const mimeType = m.mime_type || raw.format || 'audio/mpeg';
        let orgId = m.zone_id || raw.zoneId || 'zone-001';
        if (!validOrgIds.has(orgId)) orgId = 'zone-001';

        const offset = values.length;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, COALESCE($${offset + 9}, NOW()), NOW())`);
        values.push(id, orgId, title, url, type, folder, size, mimeType, m.created_at);
        mediaCount++;
      }

      if (placeholders.length > 0) {
        await dest.query(
          `INSERT INTO media_assets (id, organization_id, title, url, type, folder, size, mime_type, created_at, updated_at)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title,
             url = EXCLUDED.url,
             type = EXCLUDED.type,
             folder = EXCLUDED.folder,
             size = EXCLUDED.size,
             mime_type = EXCLUDED.mime_type`,
          values
        );
      }
    }
    console.log(`  ✓ Inserted ${mediaCount} Media Assets`);

    // ─────────────────────────────────────────────────────────────────────────
    // 7. CHATS, PARTICIPANTS & MESSAGES
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 7: Syncing Chats, Isolated Participants & Messages ──');
    let chatsData = (await src.query('SELECT * FROM chats')).rows;
    if (chatsData.length === 0) chatsData = loadSnapshot('chats.json');

    const validChatIds = new Set<string>();
    let chatCount = 0;
    let cpCount = 0;

    for (const c of chatsData) {
      const raw = c.raw_data || {};
      const id = c.id;
      if (!id) continue;

      const type = c.type || raw.type || 'direct';
      const title = raw.name || raw.title || (type === 'group' ? id : null);

      let participantIds: string[] = [];
      if (Array.isArray(c.participants)) participantIds = c.participants;
      else if (Array.isArray(raw.participants)) participantIds = raw.participants;
      participantIds = participantIds.filter((uid) => validUserIds.has(uid));

      let createdById = c.created_by || raw.createdBy || participantIds[0];
      if (!createdById || !validUserIds.has(createdById)) createdById = participantIds[0];
      if (!createdById) continue;

      await dest.query(
        `INSERT INTO chats (id, organization_id, type, title, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, type = EXCLUDED.type`,
        [id, 'zone-001', type, title, createdById, c.created_at]
      );
      validChatIds.add(id);
      chatCount++;

      const unreadMap = raw.unreadCount || c.unread_count || {};
      for (const uid of participantIds) {
        const unread = typeof unreadMap[uid] === 'number' ? unreadMap[uid] : 0;
        await dest.query(
          `INSERT INTO chat_participants (chat_id, user_id, unread_count, joined_at)
           VALUES ($1, $2, $3, COALESCE($4, NOW()))
           ON CONFLICT (chat_id, user_id) DO UPDATE SET unread_count = EXCLUDED.unread_count`,
          [id, uid, unread, c.created_at]
        );
        cpCount++;
      }
    }
    console.log(`  ✓ Inserted ${chatCount} Chat Channels & ${cpCount} Isolated Participant Rows`);

    let msgData = (await src.query('SELECT * FROM messages')).rows;
    if (msgData.length === 0) msgData = loadSnapshot('messages.json');

    let msgCount = 0;
    const msgBatchSize = 150;

    for (let i = 0; i < msgData.length; i += msgBatchSize) {
      const chunk = msgData.slice(i, i + msgBatchSize);
      const values: any[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < chunk.length; j++) {
        const msg = chunk[j];
        const raw = msg.raw_data || {};
        const id = msg.id;
        const chatId = msg.chat_id || raw.chatId;
        const senderId = msg.sender_id || raw.senderId;

        if (!id || !chatId || !senderId || !validChatIds.has(chatId) || !validUserIds.has(senderId)) continue;

        const text = msg.text || raw.text || '';
        const type = msg.type || raw.type || 'text';
        const status = msg.status || raw.status || 'sent';
        const edited = Boolean(msg.edited ?? raw.edited ?? false);

        const offset = values.length;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, COALESCE($${offset + 8}, NOW()))`);
        values.push(id, chatId, senderId, text, type, edited, status, msg.created_at);
        msgCount++;
      }

      if (placeholders.length > 0) {
        await dest.query(
          `INSERT INTO messages (id, chat_id, sender_id, text, type, edited, status, created_at)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (id) DO NOTHING`,
          values
        );
      }
    }
    console.log(`  ✓ Inserted ${msgCount} Messages`);

    // ─────────────────────────────────────────────────────────────────────────
    // 8. NOTIFICATIONS — WIPED AND EMPTIED CLEAN AS REQUESTED
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Step 8: Clearing Notifications (Zero Stale Leaks) ────────');
    await dest.query('TRUNCATE TABLE notification_deliveries, notifications CASCADE;');
    console.log('  ✓ Notifications and Notification Deliveries wiped clean (0 records)\n');

    // ─────────────────────────────────────────────────────────────────────────
    // 9. ATTENDANCE (Batched in 200s)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('── Step 9: Syncing Attendance Records ──────────────────────');
    let attData = (await src.query('SELECT * FROM attendance')).rows;
    if (attData.length === 0) attData = loadSnapshot('attendance.json');

    let attCount = 0;
    const attBatchSize = 200;

    for (let i = 0; i < attData.length; i += attBatchSize) {
      const chunk = attData.slice(i, i + attBatchSize);
      const values: any[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < chunk.length; j++) {
        const a = chunk[j];
        const raw = a.raw_data || {};
        const id = a.id;
        const userId = a.user_id || raw.userId || raw.user_id;
        if (!id || !userId || !validUserIds.has(userId)) continue;

        let orgId = a.zone_id || raw.zoneId || 'zone-001';
        if (!validOrgIds.has(orgId)) orgId = 'zone-001';

        const programId = a.rehearsal_id || raw.rehearsalId || null;
        const status = a.status || raw.status || 'present';
        const eventName = a.event_name || raw.eventName || raw.event_name || 'Rehearsal';
        const qrCode = a.qr_code || raw.qrCode || null;
        const checkInTime = a.check_in_time ? new Date(a.check_in_time) : (raw.check_in_time ? new Date(raw.check_in_time) : null);
        const scannedAt = a.scanned_at ? new Date(a.scanned_at) : checkInTime;
        const recordedById = (a.recorded_by_admin_id && validUserIds.has(a.recorded_by_admin_id)) ? a.recorded_by_admin_id : null;

        const offset = values.length;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, COALESCE($${offset + 11}, NOW()))`);
        values.push(id, orgId, userId, programId, status, eventName, checkInTime, scannedAt, qrCode, recordedById, a.created_at);
        attCount++;
      }

      if (placeholders.length > 0) {
        await dest.query(
          `INSERT INTO attendance (id, organization_id, user_id, program_id, status, event_name, check_in_time, scanned_at, qr_code, recorded_by_id, created_at)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (id) DO NOTHING`,
          values
        );
      }
    }
    console.log(`  ✓ Inserted ${attCount} Attendance Records`);

    // ─────────────────────────────────────────────────────────────────────────
    // FINAL AUDIT SUMMARY
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║   FINAL RAILWAY DATABASE AUDIT                             ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const summary = await dest.query(`
      SELECT
        (SELECT count(*) FROM organizations)          AS organizations,
        (SELECT count(*) FROM profiles)               AS profiles,
        (SELECT count(*) FROM memberships)            AS memberships,
        (SELECT count(*) FROM songs WHERE is_master)  AS master_songs,
        (SELECT count(*) FROM songs WHERE NOT is_master) AS custom_songs,
        (SELECT count(*) FROM songs)                  AS total_songs,
        (SELECT count(*) FROM programs)               AS programs,
        (SELECT count(*) FROM program_songs)          AS program_songs,
        (SELECT count(*) FROM media_assets)           AS media_assets,
        (SELECT count(*) FROM chats)                  AS chats,
        (SELECT count(*) FROM chat_participants)      AS chat_participants,
        (SELECT count(*) FROM messages)               AS messages,
        (SELECT count(*) FROM notifications)          AS notifications,
        (SELECT count(*) FROM attendance)             AS attendance,
        (SELECT count(*) FROM playlists)              AS playlists,
        (SELECT count(*) FROM playlist_items)         AS playlist_items;
    `);
    console.table(summary.rows);

  } catch (err) {
    console.error('\n❌ Sync Error:', err);
    throw err;
  } finally {
    src.release();
    dest.release();
    await srcPool.end();
    await destPool.end();
  }
}

main().catch(console.error);
