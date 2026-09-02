import { prisma } from '../src/lib/prisma';
import * as crypto from 'crypto';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const backendEnvPath = path.join(__dirname, '..', '..', 'clones', 'Loveworld-Singers-Backend', '.env.local');
const envVars: Record<string, string> = {};
if (fs.existsSync(backendEnvPath)) {
  for (const line of fs.readFileSync(backendEnvPath, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 0) continue;
    envVars[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const projectId = envVars['NEXT_PUBLIC_FIREBASE_ADMIN_PROJECT_ID'] || process.env.FIREBASE_PROJECT_ID || 'loveworld-singers-app';
const clientEmail = envVars['NEXT_PUBLIC_FIREBASE_ADMIN_CLIENT_EMAIL'] || process.env.FIREBASE_CLIENT_EMAIL || '';
const privateKey = (envVars['NEXT_PUBLIC_FIREBASE_ADMIN_PRIVATE_KEY'] || process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function getGoogleTime(): Promise<number> {
  return new Promise(r => {
    const req = https.request('https://oauth2.googleapis.com', { method: 'HEAD' }, (res: any) => {
      const d = res.headers.date;
      r(d ? Math.floor(new Date(d).getTime() / 1000) : Math.floor(Date.now() / 1000));
    });
    req.on('error', () => r(Math.floor(Date.now() / 1000)));
    req.end();
  });
}

async function getToken(): Promise<string> {
  const now = await getGoogleTime();
  return new Promise((resolve, reject) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const c = Buffer.from(JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now - 30,
      exp: now + 3600,
    })).toString('base64url');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${h}.${c}`);
    const jwt = `${h}.${c}.${sign.sign(privateKey, 'base64url')}`;
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res: any) => {
      let d = ''; res.on('data', (chunk: any) => d += chunk);
      res.on('end', () => {
        const j = JSON.parse(d);
        j.access_token ? resolve(j.access_token) : reject(new Error(d));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseVal(v: any): any {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return parseFloat(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) {
    const o: any = {};
    for (const k of Object.keys(v.mapValue?.fields || {})) o[k] = parseVal(v.mapValue.fields[k]);
    return o;
  }
  if ('arrayValue' in v) return (v.arrayValue?.values || []).map(parseVal);
  return v;
}

function parseDoc(doc: any) {
  const id = doc.name.split('/').pop();
  const o: any = { _id: id };
  for (const k of Object.keys(doc.fields || {})) o[k] = parseVal(doc.fields[k]);
  return o;
}

// Full paginated collection reader
async function fetchFullCollection(token: string, col: string): Promise<any[]> {
  const docs: any[] = [];
  let pageToken: string | null = null;
  do {
    const url: string = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${col}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res: any = await new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res: any) => {
        let d = ''; res.on('data', (c: any) => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (Array.isArray(res.documents)) {
      docs.push(...res.documents.map(parseDoc));
    }
    pageToken = res.nextPageToken || null;
  } while (pageToken);
  return docs;
}

function fsQuery(token: string, col: string, where?: any, limit = 1000): Promise<any[]> {
  return new Promise(r => {
    const q: any = { structuredQuery: { from: [{ collectionId: col }], limit } };
    if (where) q.structuredQuery.where = where;
    const body = JSON.stringify(q);
    const req = https.request(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res: any) => {
        let d = ''; res.on('data', (c: any) => d += c);
        res.on('end', () => {
          try {
            const l = JSON.parse(d);
            r(Array.isArray(l) ? l.filter((x: any) => x.document).map((x: any) => parseDoc(x.document)) : []);
          } catch { r([]); }
        });
      }
    );
    req.on('error', () => r([]));
    req.write(body);
    req.end();
  });
}

// Parallel chunk helper
async function runInParallel<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    await Promise.all(chunk.map(item => fn(item)));
  }
}

const eq = (f: string, v: string) => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value: { stringValue: v } } });

async function main() {
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('   🚀 RUNNING HIGH-SPEED UNIVERSAL DATABASE SYNCHRONIZATION ENGINE');
  console.log('════════════════════════════════════════════════════════════════════════════════\n');

  const token = await getToken();
  console.log('✅ Connected to Live Firebase Admin API');

  // ============================================================================
  // STEP 1: SYNC ZONES (organizations)
  // ============================================================================
  console.log('\n▶ [STEP 1/9] Syncing All Zones (organizations)...');
  const firebaseZones = await fetchFullCollection(token, 'zones');
  console.log(`  Found ${firebaseZones.length} zones in Firebase`);

  await runInParallel(firebaseZones, 10, async (z) => {
    await prisma.organization.upsert({
      where: { id: z._id },
      update: {
        name: z.name || z._id,
        region: z.region || null,
        code: z.slug || z._id,
        invitationCode: z.invitationCode || null,
        isHq: z._id === 'zone-001' || (z.name || '').toLowerCase().includes('headquarters'),
        isActive: true,
      },
      create: {
        id: z._id,
        name: z.name || z._id,
        region: z.region || null,
        code: z.slug || z._id,
        invitationCode: z.invitationCode || null,
        isHq: z._id === 'zone-001' || (z.name || '').toLowerCase().includes('headquarters'),
        isActive: true,
      },
    });
  });
  console.log(`  ✅ Done syncing ${firebaseZones.length} organizations`);

  // ============================================================================
  // STEP 2: SYNC GLOBAL CATEGORIES (categories)
  // ============================================================================
  console.log('\n▶ [STEP 2/9] Syncing Global Categories (categories)...');
  const fbCategories = await fetchFullCollection(token, 'categories');
  console.log(`  Found ${fbCategories.length} categories in Firebase`);

  await runInParallel(fbCategories, 15, async (c) => {
    await prisma.category.upsert({
      where: { id: c._id },
      update: {
        name: c.name || c._id,
        color: c.color || '#8B5CF6',
        type: 'SONG',
      },
      create: {
        id: c._id,
        name: c.name || c._id,
        color: c.color || '#8B5CF6',
        type: 'SONG',
      },
    });
  });
  console.log(`  ✅ Done syncing ${fbCategories.length} categories`);

  // ============================================================================
  // STEP 3: SYNC SUBGROUPS (groups)
  // ============================================================================
  console.log('\n▶ [STEP 3/9] Syncing Subgroups & Church Units (groups)...');
  const fbSubgroups = await fetchFullCollection(token, 'subgroups');
  console.log(`  Found ${fbSubgroups.length} subgroups in Firebase`);

  await runInParallel(fbSubgroups, 10, async (sg) => {
    const orgId = sg.zoneId || 'zone-001';
    await prisma.organization.upsert({
      where: { id: orgId },
      update: {},
      create: { id: orgId, name: orgId },
    });

    await prisma.group.upsert({
      where: { id: sg._id },
      update: {
        name: sg.name || sg._id,
        description: sg.description || null,
        type: sg.type || 'church',
        status: sg.status || 'active',
        estimatedMembers: Array.isArray(sg.memberIds) ? sg.memberIds.length : (sg.estimatedMembers || 0),
        organizationId: orgId,
      },
      create: {
        id: sg._id,
        name: sg.name || sg._id,
        description: sg.description || null,
        type: sg.type || 'church',
        status: sg.status || 'active',
        estimatedMembers: Array.isArray(sg.memberIds) ? sg.memberIds.length : (sg.estimatedMembers || 0),
        organizationId: orgId,
      },
    });
  });
  console.log(`  ✅ Done syncing ${fbSubgroups.length} groups`);

  // ============================================================================
  // STEP 4: SYNC USERS & MULTI-ZONE MEMBERSHIPS (profiles & memberships)
  // ============================================================================
  console.log('\n▶ [STEP 4/9] Syncing Profiles & Multi-Zone Memberships...');
  const fbProfiles = await fetchFullCollection(token, 'profiles');
  const fbZoneMembers = await fetchFullCollection(token, 'zone_members');
  console.log(`  Found ${fbProfiles.length} profiles and ${fbZoneMembers.length} zone_member records`);

  const userSubgroupMap: Record<string, string> = {};
  for (const sg of fbSubgroups) {
    if (Array.isArray(sg.memberIds)) {
      for (const mId of sg.memberIds) {
        userSubgroupMap[mId] = sg._id;
      }
    }
  }

  // Pre-fetch all emails currently in Postgres to avoid unique constraint violations
  const existingUsers = await prisma.user.findMany({ select: { id: true, email: true } });
  const emailToIdMap = new Map<string, string>();
  for (const u of existingUsers) {
    if (u.email) emailToIdMap.set(u.email.toLowerCase().trim(), u.id);
  }

  const profileMap: Record<string, any> = {};
  for (const p of fbProfiles) {
    profileMap[p._id] = p;
  }

  await runInParallel(fbProfiles, 25, async (p) => {
    let email = p.email ? p.email.toLowerCase().trim() : null;
    if (email && emailToIdMap.has(email) && emailToIdMap.get(email) !== p._id) {
      email = null; // Prevent unique constraint collisions
    } else if (email) {
      emailToIdMap.set(email, p._id);
    }

    try {
      await prisma.user.upsert({
        where: { id: p._id },
        update: {
          ...(email ? { email } : {}),
          firstName: p.first_name || p.firstName || '',
          lastName: p.last_name || p.lastName || '',
          phone: p.phone_number || p.phone || null,
          avatarUrl: p.profile_image_url || p.profile_image || p.avatarUrl || null,
          kingschatId: p.kingschat_id || p.kingsChatId || null,
          profileCompleted: p.profile_completed === true,
        },
        create: {
          id: p._id,
          email: email,
          firstName: p.first_name || p.firstName || '',
          lastName: p.last_name || p.lastName || '',
          phone: p.phone_number || p.phone || null,
          avatarUrl: p.profile_image_url || p.profile_image || p.avatarUrl || null,
          kingschatId: p.kingschat_id || p.kingsChatId || null,
          profileCompleted: p.profile_completed === true,
        },
      });
    } catch (err: any) {
      // safe fallback
    }
  });

  // Sync all zone_members into memberships
  let membershipCount = 0;
  await runInParallel(fbZoneMembers, 25, async (zm) => {
    if (!zm.userId || !zm.zoneId) return;
    const userProfile = profileMap[zm.userId];
    if (!userProfile) return;

    await prisma.organization.upsert({
      where: { id: zm.zoneId },
      update: {},
      create: { id: zm.zoneId, name: zm.zoneId },
    });

    const voicePart = userProfile.designation || zm.voicePart || null;
    const groupId = userSubgroupMap[zm.userId] || null;

    try {
      await prisma.membership.upsert({
        where: {
          userId_organizationId: {
            userId: zm.userId,
            organizationId: zm.zoneId,
          },
        },
        update: {
          role: (zm.role || 'MEMBER').toUpperCase(),
          voicePart: voicePart,
          groupId: groupId,
          status: (zm.status || 'ACTIVE').toUpperCase(),
        },
        create: {
          userId: zm.userId,
          organizationId: zm.zoneId,
          role: (zm.role || 'MEMBER').toUpperCase(),
          voicePart: voicePart,
          groupId: groupId,
          status: (zm.status || 'ACTIVE').toUpperCase(),
        },
      });
      membershipCount++;
    } catch {
      // safe fallback
    }
  });
  console.log(`  ✅ Done syncing ${fbProfiles.length} profiles and ${membershipCount} active memberships`);

  // ============================================================================
  // STEP 5: SYNC SONGS & REPERTOIRE (master_songs, songs, zone_songs)
  // ============================================================================
  console.log('\n▶ [STEP 5/9] Syncing Songs Repertoire...');
  const masterSongs = await fetchFullCollection(token, 'master_songs');
  const globalSongs = await fetchFullCollection(token, 'songs');
  const zoneSongs = await fetchFullCollection(token, 'zone_songs');
  console.log(`  Found ${masterSongs.length} master songs, ${globalSongs.length} global songs, ${zoneSongs.length} zone songs`);

  const allSongs = [...masterSongs.map(s => ({ ...s, isMaster: true })), ...globalSongs, ...zoneSongs];
  await runInParallel(allSongs, 25, async (s) => {
    const orgId = s.zoneId || null;
    if (orgId) {
      await prisma.organization.upsert({
        where: { id: orgId },
        update: {},
        create: { id: orgId, name: orgId },
      });
    }

    await prisma.song.upsert({
      where: { id: s._id },
      update: {
        title: s.title || 'Untitled Song',
        key: s.key || null,
        tempo: s.tempo || null,
        lyrics: s.lyrics || null,
        writer: s.writer || null,
        category: Array.isArray(s.categories) && s.categories.length > 0 ? s.categories[0] : (s.category || null),
        audioFile: s.audioFile || null,
        audioUrls: s.audioUrls && Object.keys(s.audioUrls).length > 0 ? s.audioUrls : null,
        conductor: s.conductor || null,
        leadSinger: s.leadSinger || null,
        drummer: s.drummer || null,
        leadKeyboardist: s.leadKeyboardist || null,
        leadGuitarist: s.leadGuitarist || null,
        bassGuitarist: s.bassGuitarist || null,
        solfas: s.solfas || s.solfa || null,
        isMaster: s.isMaster === true,
        rehearsalCount: s.rehearsalCount || 0,
        status: s.status || 'active',
        isActive: s.isActive !== false,
        organizationId: orgId,
      },
      create: {
        id: s._id,
        title: s.title || 'Untitled Song',
        key: s.key || null,
        tempo: s.tempo || null,
        lyrics: s.lyrics || null,
        writer: s.writer || null,
        category: Array.isArray(s.categories) && s.categories.length > 0 ? s.categories[0] : (s.category || null),
        audioFile: s.audioFile || null,
        audioUrls: s.audioUrls && Object.keys(s.audioUrls).length > 0 ? s.audioUrls : null,
        conductor: s.conductor || null,
        leadSinger: s.leadSinger || null,
        drummer: s.drummer || null,
        leadKeyboardist: s.leadKeyboardist || null,
        leadGuitarist: s.leadGuitarist || null,
        bassGuitarist: s.bassGuitarist || null,
        solfas: s.solfas || s.solfa || null,
        isMaster: s.isMaster === true,
        rehearsalCount: s.rehearsalCount || 0,
        status: s.status || 'active',
        isActive: s.isActive !== false,
        organizationId: orgId,
      },
    });
  });
  console.log(`  ✅ Done syncing ${allSongs.length} songs`);

  // ============================================================================
  // STEP 6: SYNC PROGRAMS & SEQUENTIAL PROGRAM SONGS (praise_nights & praise_night_songs)
  // ============================================================================
  console.log('\n▶ [STEP 6/9] Syncing Programs & Sequential Program Songs...');
  const praiseNights = await fetchFullCollection(token, 'praise_nights');
  const zonePraiseNights = await fetchFullCollection(token, 'zone_praise_nights');
  const allPrograms = [...praiseNights, ...zonePraiseNights];
  console.log(`  Found ${allPrograms.length} total programs in Firebase`);

  for (const p of allPrograms) {
    const orgId = p.zoneId || 'zone-001';
    await prisma.organization.upsert({
      where: { id: orgId },
      update: {},
      create: { id: orgId, name: orgId },
    });

    await prisma.program.upsert({
      where: { id: p._id },
      update: {
        name: p.name || 'Untitled Program',
        date: p.date || null,
        category: p.category || 'praise_night',
        status: p.status || 'pre-rehearsal',
        location: p.location || null,
        bannerImage: p.bannerImage || null,
        organizationId: orgId,
        isActive: p.isActive === true,
      },
      create: {
        id: p._id,
        name: p.name || 'Untitled Program',
        date: p.date || null,
        category: p.category || 'praise_night',
        status: p.status || 'pre-rehearsal',
        location: p.location || null,
        bannerImage: p.bannerImage || null,
        organizationId: orgId,
        isActive: p.isActive === true,
      },
    });

    const pnSongs = await fsQuery(token, 'praise_night_songs', eq('praiseNightId', p._id), 500);
    const zSongs = pnSongs.length === 0 ? await fsQuery(token, 'zone_songs', eq('praiseNightId', p._id), 500) : [];
    const targetSongs = [...pnSongs, ...zSongs];

    if (targetSongs.length > 0) {
      const categoryOrder: string[] = p.categoryOrder || [];
      const orderedList: any[] = [];

      for (const cat of categoryOrder) {
        const matching = targetSongs.filter(s => (s.category || '') === cat || (Array.isArray(s.categories) && s.categories.includes(cat)));
        orderedList.push(...matching);
      }
      for (const s of targetSongs) {
        if (!orderedList.find(x => x._id === s._id)) {
          orderedList.push(s);
        }
      }

      for (let i = 0; i < orderedList.length; i++) {
        const s = orderedList[i];
        const orderNum = i + 1;

        await prisma.song.upsert({
          where: { id: s._id },
          update: {
            title: s.title || 'Untitled',
            key: s.key || null,
            category: s.category || null,
            leadSinger: s.leadSinger || null,
            conductor: s.conductor || null,
            drummer: s.drummer || null,
            leadKeyboardist: s.leadKeyboardist || null,
            audioFile: s.audioFile || null,
            audioUrls: s.audioUrls && Object.keys(s.audioUrls).length > 0 ? s.audioUrls : null,
            rehearsalCount: s.rehearsalCount || 0,
          },
          create: {
            id: s._id,
            title: s.title || 'Untitled',
            key: s.key || null,
            category: s.category || null,
            leadSinger: s.leadSinger || null,
            conductor: s.conductor || null,
            drummer: s.drummer || null,
            leadKeyboardist: s.leadKeyboardist || null,
            audioFile: s.audioFile || null,
            audioUrls: s.audioUrls && Object.keys(s.audioUrls).length > 0 ? s.audioUrls : null,
            rehearsalCount: s.rehearsalCount || 0,
            organizationId: orgId,
          },
        });

        await prisma.programSong.upsert({
          where: {
            programId_songId: {
              programId: p._id,
              songId: s._id,
            },
          },
          update: {
            order: orderNum,
          },
          create: {
            programId: p._id,
            songId: s._id,
            order: orderNum,
          },
        });
      }
    }
  }
  console.log(`  ✅ Done syncing ${allPrograms.length} programs with full sequential song orders`);

  // ============================================================================
  // STEP 7: SYNC CHATS & MESSAGES (chats_v2 & messages_v2)
  // ============================================================================
  console.log('\n▶ [STEP 7/9] Syncing Chats & Messages (chats_v2)...');
  const allChats = await fetchFullCollection(token, 'chats_v2');
  console.log(`  Found ${allChats.length} chats in chats_v2`);

  for (const c of allChats) {
    const participants: string[] = Array.isArray(c.participants) ? c.participants : [];
    let chatTitle = c.name || c.groupName || c.title || '';

    if (!chatTitle && c.type === 'direct' && participants.length >= 2) {
      const names = participants.map(pId => {
        const prof = profileMap[pId];
        return prof ? `${prof.first_name || ''} ${prof.last_name || ''}`.trim() : pId;
      });
      chatTitle = `DM: ${names.join(' & ')}`;
    } else if (!chatTitle) {
      chatTitle = `Chat (${c._id})`;
    }

    const createdBy = participants[0] || 'system';
    if (!profileMap[createdBy]) {
      await prisma.user.upsert({
        where: { id: createdBy },
        update: {},
        create: { id: createdBy, firstName: 'User', lastName: 'Member' },
      });
    }

    await prisma.chat.upsert({
      where: { id: c._id },
      update: {
        title: chatTitle,
        type: (c.type || 'direct').toUpperCase(),
      },
      create: {
        id: c._id,
        title: chatTitle,
        type: (c.type || 'direct').toUpperCase(),
        createdById: createdBy,
      },
    });

    for (const pId of participants) {
      if (!profileMap[pId]) {
        await prisma.user.upsert({
          where: { id: pId },
          update: {},
          create: { id: pId, firstName: 'User', lastName: 'Member' },
        });
      }

      await prisma.chatParticipant.upsert({
        where: {
          chatId_userId: {
            chatId: c._id,
            userId: pId,
          },
        },
        update: {},
        create: {
          chatId: c._id,
          userId: pId,
        },
      });
    }

    const msgs = await fsQuery(token, 'messages_v2', eq('chatId', c._id), 200);
    for (const m of msgs) {
      const senderId = m.senderId || createdBy;
      if (!profileMap[senderId]) {
        await prisma.user.upsert({
          where: { id: senderId },
          update: {},
          create: { id: senderId, firstName: 'User', lastName: 'Member' },
        });
      }

      await prisma.message.upsert({
        where: { id: m._id },
        update: {
          text: m.text || m.content || '(attachment)',
        },
        create: {
          id: m._id,
          chatId: c._id,
          senderId: senderId,
          text: m.text || m.content || '(attachment)',
        },
      });
    }
  }
  console.log(`  ✅ Done syncing ${allChats.length} chats and messages`);

  // ============================================================================
  // STEP 8: SYNC PLAYLISTS & FAVORITES
  // ============================================================================
  console.log('\n▶ [STEP 8/9] Syncing Playlists & Favorites...');
  const userFavorites = await fetchFullCollection(token, 'user_favorites');
  const userPlaylists = await fetchFullCollection(token, 'user_playlists');
  const audiolabPlaylists = await fetchFullCollection(token, 'audiolab_playlists');

  for (const fav of userFavorites) {
    const uid = fav._id;
    if (!profileMap[uid]) continue;
    const songIds: string[] = Array.isArray(fav.songs) ? fav.songs : [];
    if (songIds.length === 0) continue;

    const favPlaylist = await prisma.playlist.upsert({
      where: { id: `${uid}_favorites` },
      update: { title: 'Favorite Songs' },
      create: { id: `${uid}_favorites`, userId: uid, title: 'Favorite Songs', isPublic: false },
    });

    for (let i = 0; i < songIds.length; i++) {
      const sId = songIds[i];
      const songExists = await prisma.song.findUnique({ where: { id: sId } });
      if (songExists) {
        await prisma.playlistItem.upsert({
          where: {
            playlistId_songId: {
              playlistId: favPlaylist.id,
              songId: sId,
            },
          },
          update: { order: i + 1 },
          create: {
            playlistId: favPlaylist.id,
            songId: sId,
            order: i + 1,
          },
        });
      }
    }
  }

  for (const p of userPlaylists) {
    if (!p.userId || !profileMap[p.userId]) continue;
    const songIds: string[] = Array.isArray(p.songs) ? p.songs : (Array.isArray(p.songIds) ? p.songIds : []);

    const pl = await prisma.playlist.upsert({
      where: { id: p._id },
      update: { title: p.name || p.title || 'Playlist' },
      create: { id: p._id, userId: p.userId, title: p.name || p.title || 'Playlist', isPublic: false },
    });

    for (let i = 0; i < songIds.length; i++) {
      const sId = songIds[i];
      const songExists = await prisma.song.findUnique({ where: { id: sId } });
      if (songExists) {
        await prisma.playlistItem.upsert({
          where: {
            playlistId_songId: {
              playlistId: pl.id,
              songId: sId,
            },
          },
          update: { order: i + 1 },
          create: {
            playlistId: pl.id,
            songId: sId,
            order: i + 1,
          },
        });
      }
    }
  }

  for (const p of audiolabPlaylists) {
    if (!p.userId || !profileMap[p.userId]) continue;
    const songIds: string[] = Array.isArray(p.songIds) ? p.songIds : [];

    const pl = await prisma.playlist.upsert({
      where: { id: `audiolab_${p._id}` },
      update: { title: p.title || p.name || 'Audiolab Playlist' },
      create: { id: `audiolab_${p._id}`, userId: p.userId, title: p.title || p.name || 'Audiolab Playlist', isPublic: false },
    });

    for (let i = 0; i < songIds.length; i++) {
      const sId = songIds[i];
      const songExists = await prisma.song.findUnique({ where: { id: sId } });
      if (songExists) {
        await prisma.playlistItem.upsert({
          where: {
            playlistId_songId: {
              playlistId: pl.id,
              songId: sId,
            },
          },
          update: { order: i + 1 },
          create: {
            playlistId: pl.id,
            songId: sId,
            order: i + 1,
          },
        });
      }
    }
  }
  console.log(`  ✅ Done syncing playlists and favorites`);

  // ============================================================================
  // STEP 9: SYNC ATTENDANCES & SUBMITTED SONGS
  // ============================================================================
  console.log('\n▶ [STEP 9/9] Syncing Attendances & Submitted Songs...');
  const attendances = await fetchFullCollection(token, 'attendance');
  for (const a of attendances) {
    if (!a.userId || !profileMap[a.userId]) continue;
    const orgId = a.zoneId || 'zone-001';

    await prisma.attendance.upsert({
      where: { id: a._id },
      update: {
        status: a.status || 'present',
      },
      create: {
        id: a._id,
        userId: a.userId,
        organizationId: orgId,
        status: a.status || 'present',
        method: a.method || 'qr_scan',
      },
    });
  }

  const submittedSongs = await fetchFullCollection(token, 'submitted_songs');
  for (const s of submittedSongs) {
    const userId = s.submittedBy?.userId || s.userId;
    if (!userId || !profileMap[userId]) continue;
    const orgId = s.zoneId || 'zone-001';

    await prisma.submittedSong.upsert({
      where: { id: s._id },
      update: {
        title: s.title || 'Untitled Submission',
        status: (s.status || 'review').toLowerCase(),
        audioUrl: s.audioUrl || null,
        lyrics: s.lyrics || null,
      },
      create: {
        id: s._id,
        title: s.title || 'Untitled Submission',
        status: (s.status || 'review').toLowerCase(),
        audioUrl: s.audioUrl || null,
        lyrics: s.lyrics || null,
        userId: userId,
        organizationId: orgId,
      },
    });
  }
  console.log(`  ✅ Done syncing attendances and submitted songs`);

  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('   🎉 COMPLETE UNIVERSAL SYNCHRONIZATION FINISHED SUCCESSFULLY!');
  console.log('════════════════════════════════════════════════════════════════════════════════\n');

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal sync error:', err);
  prisma.$disconnect();
});
