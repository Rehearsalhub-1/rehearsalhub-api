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

async function runInParallel<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    await Promise.all(chunk.map(item => fn(item)));
  }
}

async function main() {
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('   🌟 UNIVERSAL MASTER SYNCHRONIZATION & RESOLUTION ENGINE');
  console.log('════════════════════════════════════════════════════════════════════════════════\n');

  const token = await getToken();
  console.log('✅ Connected to Live Firebase API');

  // ============================================================================
  // STEP 1: FETCH ALL CORE REFERENCE DATA
  // ============================================================================
  console.log('\n▶ [1/6] Loading Full Firestore Collections into Memory...');
  const [profiles, zones, zoneMembers, subgroups, categories] = await Promise.all([
    fetchFullCollection(token, 'profiles'),
    fetchFullCollection(token, 'zones'),
    fetchFullCollection(token, 'zone_members'),
    fetchFullCollection(token, 'subgroups'),
    fetchFullCollection(token, 'categories'),
  ]);
  console.log(`  Loaded: ${profiles.length} Profiles, ${zones.length} Zones, ${zoneMembers.length} Zone Members, ${subgroups.length} Subgroups, ${categories.length} Categories`);

  // Build profile name resolver map
  const profMap = new Map<string, any>();
  profiles.forEach(p => profMap.set(p._id, p));

  const resolveUserName = (pId: string): string => {
    const p = profMap.get(pId);
    if (!p) return pId;
    const name = `${p.first_name || p.firstName || ''} ${p.last_name || p.lastName || ''}`.trim();
    if (name) return name;
    if (p.email) return p.email;
    if (p.phone_number || p.phone) return p.phone_number || p.phone;
    return 'Member';
  };

  // ============================================================================
  // STEP 2: SYNC ZONES, CATEGORIES & SUBGROUPS
  // ============================================================================
  console.log('\n▶ [2/6] Syncing Organizations, Categories & Subgroups...');
  await runInParallel(zones, 10, async (z) => {
    await prisma.organization.upsert({
      where: { id: z._id },
      update: {
        name: z.name || z._id,
        region: z.region || null,
        code: z.slug || z._id,
        isHq: z._id === 'zone-001' || (z.name || '').toLowerCase().includes('headquarters'),
        isActive: true,
      },
      create: {
        id: z._id,
        name: z.name || z._id,
        region: z.region || null,
        code: z.slug || z._id,
        isHq: z._id === 'zone-001' || (z.name || '').toLowerCase().includes('headquarters'),
        isActive: true,
      },
    });
  });

  await runInParallel(categories, 15, async (c) => {
    await prisma.category.upsert({
      where: { id: c._id },
      update: { name: c.name || c._id, color: c.color || '#8B5CF6', type: 'SONG' },
      create: { id: c._id, name: c.name || c._id, color: c.color || '#8B5CF6', type: 'SONG' },
    });
  });

  await runInParallel(subgroups, 10, async (sg) => {
    const orgId = sg.zoneId || 'zone-001';
    await prisma.organization.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
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

  // ============================================================================
  // STEP 3: SYNC USERS & MULTI-ZONE MEMBERSHIPS (WITH ROLES & SUBGROUPS)
  // ============================================================================
  console.log('\n▶ [3/6] Syncing All User Profiles & Multi-Zone Memberships...');
  const userSubgroupMap: Record<string, string> = {};
  for (const sg of subgroups) {
    if (Array.isArray(sg.memberIds)) {
      for (const mId of sg.memberIds) userSubgroupMap[mId] = sg._id;
    }
  }

  const existingUsers = await prisma.user.findMany({ select: { id: true, email: true } });
  const emailToIdMap = new Map<string, string>();
  for (const u of existingUsers) {
    if (u.email) emailToIdMap.set(u.email.toLowerCase().trim(), u.id);
  }

  await runInParallel(profiles, 25, async (p) => {
    let email = p.email ? p.email.toLowerCase().trim() : null;
    if (p._id === '8ILWjbl9IbgbuxBK9P23mB6pZBt1') {
      email = 'takeshopstore@gmail.com'; // Enforce clean email without extra 's'
    } else if (email && emailToIdMap.has(email) && emailToIdMap.get(email) !== p._id) {
      email = null;
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
    } catch {}
  });

  await runInParallel(zoneMembers, 25, async (zm) => {
    if (!zm.userId || !zm.zoneId) return;
    const userProfile = profMap.get(zm.userId);
    if (!userProfile) return;

    await prisma.organization.upsert({ where: { id: zm.zoneId }, update: {}, create: { id: zm.zoneId, name: zm.zoneId } });
    const voicePart = userProfile.designation || zm.voicePart || 'Member';
    const groupId = userSubgroupMap[zm.userId] || null;

    try {
      await prisma.membership.upsert({
        where: { userId_organizationId: { userId: zm.userId, organizationId: zm.zoneId } },
        update: { role: (zm.role || 'MEMBER').toUpperCase(), voicePart, groupId, status: (zm.status || 'ACTIVE').toUpperCase() },
        create: { userId: zm.userId, organizationId: zm.zoneId, role: (zm.role || 'MEMBER').toUpperCase(), voicePart, groupId, status: (zm.status || 'ACTIVE').toUpperCase() },
      });
    } catch {}
  });

  // ============================================================================
  // STEP 4: SYNC MASTER SONGS & REPERTOIRE (WITH FULL STEMS, KEYS, SOLFAS)
  // ============================================================================
  console.log('\n▶ [4/6] Syncing Songs Repertoire & Playlists...');
  const [masterSongs, globalSongs, zoneSongs] = await Promise.all([
    fetchFullCollection(token, 'master_songs'),
    fetchFullCollection(token, 'songs'),
    fetchFullCollection(token, 'zone_songs'),
  ]);

  const allSongs = [...masterSongs.map(s => ({ ...s, isMaster: true })), ...globalSongs, ...zoneSongs];
  const songMap = new Map<string, any>();
  allSongs.forEach(s => songMap.set(s._id, s));

  await runInParallel(allSongs, 25, async (s) => {
    const orgId = s.zoneId || null;
    if (orgId) await prisma.organization.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });

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

  // Sync Favorites and Playlists with Full Song Resolution
  const [userFavorites, userPlaylists, audiolabPlaylists] = await Promise.all([
    fetchFullCollection(token, 'user_favorites'),
    fetchFullCollection(token, 'user_playlists'),
    fetchFullCollection(token, 'audiolab_playlists'),
  ]);

  for (const fav of userFavorites) {
    const uid = fav._id;
    if (!profMap.has(uid)) continue;
    const songIds: string[] = Array.isArray(fav.songs) ? fav.songs : [];
    if (songIds.length === 0) continue;

    const favPl = await prisma.playlist.upsert({
      where: { id: `${uid}_favorites` },
      update: { title: 'Favorite Songs' },
      create: { id: `${uid}_favorites`, userId: uid, title: 'Favorite Songs', isPublic: false },
    });

    for (let i = 0; i < songIds.length; i++) {
      const sId = songIds[i];
      if (songMap.has(sId)) {
        await prisma.playlistItem.upsert({
          where: { playlistId_songId: { playlistId: favPl.id, songId: sId } },
          update: { order: i + 1 },
          create: { playlistId: favPl.id, songId: sId, order: i + 1 },
        });
      }
    }
  }

  for (const p of userPlaylists) {
    if (!p.userId || !profMap.has(p.userId)) continue;
    const songIds: string[] = Array.isArray(p.songs) ? p.songs : (Array.isArray(p.songIds) ? p.songIds : []);
    const pl = await prisma.playlist.upsert({
      where: { id: p._id },
      update: { title: p.name || p.title || 'Playlist' },
      create: { id: p._id, userId: p.userId, title: p.name || p.title || 'Playlist', isPublic: false },
    });

    for (let i = 0; i < songIds.length; i++) {
      const sId = songIds[i];
      if (songMap.has(sId)) {
        await prisma.playlistItem.upsert({
          where: { playlistId_songId: { playlistId: pl.id, songId: sId } },
          update: { order: i + 1 },
          create: { playlistId: pl.id, songId: sId, order: i + 1 },
        });
      }
    }
  }

  for (const p of audiolabPlaylists) {
    if (!p.userId || !profMap.has(p.userId)) continue;
    const songIds: string[] = Array.isArray(p.songIds) ? p.songIds : [];
    const pl = await prisma.playlist.upsert({
      where: { id: `audiolab_${p._id}` },
      update: { title: p.title || p.name || 'Audiolab' },
      create: { id: `audiolab_${p._id}`, userId: p.userId, title: p.title || p.name || 'Audiolab', isPublic: false },
    });

    for (let i = 0; i < songIds.length; i++) {
      const sId = songIds[i];
      if (songMap.has(sId)) {
        await prisma.playlistItem.upsert({
          where: { playlistId_songId: { playlistId: pl.id, songId: sId } },
          update: { order: i + 1 },
          create: { playlistId: pl.id, songId: sId, order: i + 1 },
        });
      }
    }
  }

  // ============================================================================
  // STEP 5: UNIVERSAL CHATS & DIRECT MESSAGE TITLE RESOLUTION
  // ============================================================================
  console.log('\n▶ [5/6] Universal Chat Title Resolution...');
  const allChats = await fetchFullCollection(token, 'chats_v2');

  for (const c of allChats) {
    const participants: string[] = Array.isArray(c.participants) ? c.participants : [];
    const isDirect = c.type === 'direct' || c.isDirect === true || (!c.name && participants.length === 2);

    let chatTitle = c.name || c.groupName || c.title || '';

    if (isDirect) {
      const names = participants.map(resolveUserName).filter(Boolean);
      chatTitle = names.length >= 2 ? `DM: ${names.join(' & ')}` : (names[0] ? `DM with ${names[0]}` : 'Direct Message');
    } else if (!chatTitle) {
      chatTitle = 'Group Chat';
    }

    const createdBy = participants[0] || 'system';
    if (!profMap.has(createdBy)) {
      await prisma.user.upsert({ where: { id: createdBy }, update: {}, create: { id: createdBy, firstName: 'User', lastName: 'Member' } });
    }

    await prisma.chat.upsert({
      where: { id: c._id },
      update: { title: chatTitle, type: isDirect ? 'DIRECT' : 'GROUP' },
      create: { id: c._id, title: chatTitle, type: isDirect ? 'DIRECT' : 'GROUP', createdById: createdBy },
    });

    for (const pId of participants) {
      if (!profMap.has(pId)) {
        await prisma.user.upsert({ where: { id: pId }, update: {}, create: { id: pId, firstName: 'User', lastName: 'Member' } });
      }
      await prisma.chatParticipant.upsert({
        where: { chatId_userId: { chatId: c._id, userId: pId } },
        update: {},
        create: { chatId: c._id, userId: pId },
      });
    }
  }

  // ============================================================================
  // STEP 6: UNIVERSAL PROGRAM CATEGORIES & SEQUENTIAL SONG ORDERS
  // ============================================================================
  console.log('\n▶ [6/6] Finalizing All Program Song Sequences by Leadership Categories...');
  const [praiseNights, zonePraiseNights, allPnSongs] = await Promise.all([
    fetchFullCollection(token, 'praise_nights'),
    fetchFullCollection(token, 'zone_praise_nights'),
    fetchFullCollection(token, 'praise_night_songs'),
  ]);

  const allPrograms = [...praiseNights, ...zonePraiseNights];
  for (const pn of allPrograms) {
    const orgId = pn.zoneId || 'zone-001';
    await prisma.organization.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });

    await prisma.program.upsert({
      where: { id: pn._id },
      update: {
        name: pn.name || 'Untitled Program',
        date: pn.date || null,
        category: pn.category || 'praise_night',
        status: pn.status || 'pre-rehearsal',
        location: pn.location || null,
        bannerImage: pn.bannerImage || null,
        organizationId: orgId,
        isActive: pn.isActive === true,
      },
      create: {
        id: pn._id,
        name: pn.name || 'Untitled Program',
        date: pn.date || null,
        category: pn.category || 'praise_night',
        status: pn.status || 'pre-rehearsal',
        location: pn.location || null,
        bannerImage: pn.bannerImage || null,
        organizationId: orgId,
        isActive: pn.isActive === true,
      },
    });

    const pnSongs = allPnSongs.filter(s => s.praiseNightId === pn._id);
    if (pnSongs.length === 0) continue;

    const categoryOrder: string[] = pn.categoryOrder || [];
    const ordered: any[] = [];
    for (const cat of categoryOrder) {
      const match = pnSongs.filter(s => (s.category || '') === cat || (Array.isArray(s.categories) && s.categories.includes(cat)));
      ordered.push(...match);
    }
    for (const s of pnSongs) {
      if (!ordered.find(x => x._id === s._id)) ordered.push(s);
    }

    for (let i = 0; i < ordered.length; i++) {
      const s = ordered[i];
      const seq = i + 1;

      // Upsert song first
      await prisma.song.upsert({
        where: { id: s._id },
        update: {
          title: s.title || 'Untitled',
          key: s.key || null,
          category: s.category || (Array.isArray(s.categories) && s.categories[0]) || null,
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
          category: s.category || (Array.isArray(s.categories) && s.categories[0]) || null,
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
        where: { programId_songId: { programId: pn._id, songId: s._id } },
        update: { order: seq },
        create: { programId: pn._id, songId: s._id, order: seq },
      });
    }
  }

  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('   🎉 UNIVERSAL SYNCHRONIZATION COMPLETED SUCCESSFULLY!');
  console.log('════════════════════════════════════════════════════════════════════════════════\n');

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal error during universal sync:', err);
  prisma.$disconnect();
});
