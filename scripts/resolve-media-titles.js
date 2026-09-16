const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');

const envFile = path.join(__dirname, '../../clones/Loveworld-Singers-Backend/.env.local');
const envVars = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 0) continue;
    envVars[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
const projectId = envVars['NEXT_PUBLIC_FIREBASE_ADMIN_PROJECT_ID'] || 'loveworld-singers-app';
const clientEmail = envVars['NEXT_PUBLIC_FIREBASE_ADMIN_CLIENT_EMAIL'] || '';
const privateKey = (envVars['NEXT_PUBLIC_FIREBASE_ADMIN_PRIVATE_KEY'] || '').replace(/\\n/g, '\n');

function getGoogleTime() {
  return new Promise(r => { const req = https.request('https://oauth2.googleapis.com', { method: 'HEAD' }, (res) => { const d = res.headers.date; r(d ? Math.floor(new Date(d).getTime() / 1000) : Math.floor(Date.now() / 1000)); }); req.on('error', () => r(Math.floor(Date.now() / 1000))); req.end(); });
}
async function getToken() {
  const now = await getGoogleTime();
  return new Promise((resolve, reject) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const c = Buffer.from(JSON.stringify({ iss: clientEmail, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now - 30, exp: now + 3600 })).toString('base64url');
    const sign = crypto.createSign('RSA-SHA256'); sign.update(`${h}.${c}`);
    const jwt = `${h}.${c}.${sign.sign(privateKey, 'base64url')}`;
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(new Error(d)); }); });
    req.on('error', reject); req.write(body); req.end();
  });
}
function parseVal(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return parseFloat(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) { const o = {}; for (const k of Object.keys(v.mapValue?.fields || {})) o[k] = parseVal(v.mapValue.fields[k]); return o; }
  if ('arrayValue' in v) return (v.arrayValue?.values || []).map(parseVal);
  return v;
}
function parseDoc(doc) { const id = doc.name.split('/').pop(); const o = { _id: id }; for (const k of Object.keys(doc.fields || {})) o[k] = parseVal(doc.fields[k]); return o; }

function fsFetchAll(token, col) {
  return new Promise((resolve) => {
    const docs = [];
    function fetchPage(pageToken = null) {
      let url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${col}?pageSize=300`;
      if (pageToken) url += `&pageToken=${pageToken}`;
      const req = https.request(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.documents) docs.push(...j.documents.map(parseDoc));
            if (j.nextPageToken) fetchPage(j.nextPageToken);
            else resolve(docs);
          } catch (e) { resolve(docs); }
        });
      });
      req.on('error', () => resolve(docs));
      req.end();
    }
    fetchPage();
  });
}

function extractHash(url) {
  if (!url) return null;
  const filename = url.split('/').pop();
  const base = filename.split('.')[0];
  const hash = base.split('_')[0];
  return hash;
}

async function main() {
  console.log('Connecting to PostgreSQL & Firestore...');
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();

  const token = await getToken();
  console.log('Fetching Firestore cloudinary_media records...');
  const [cldMedia, zoneMedia] = await Promise.all([
    fsFetchAll(token, 'cloudinary_media'),
    fsFetchAll(token, 'zone_cloudinary_media'),
  ]);
  console.log(`Fetched ${cldMedia.length} cloudinary_media and ${zoneMedia.length} zone_cloudinary_media docs.`);

  const map = new Map();
  for (const doc of [...cldMedia, ...zoneMedia]) {
    const name = (doc.name || '').trim();
    if (!name || /^[a-z0-9_-]{15,35}$/i.test(name.replace(/\.[a-z0-9]+$/i, ''))) continue;

    if (doc.publicId) {
      const pubHash = doc.publicId.split('/').pop();
      if (pubHash && pubHash.length >= 15) {
        map.set(pubHash, name);
      }
    }
    if (doc.url) {
      const urlHash = extractHash(doc.url);
      if (urlHash && urlHash.length >= 15) {
        map.set(urlHash, name);
      }
    }
  }
  console.log(`Built map with ${map.size} hash -> original name entries.`);

  const res = await pgClient.query(`
    SELECT id, title, url, created_at, type
    FROM media_assets
    WHERE title LIKE 'Rehearsal Audio%'
       OR title ~ '^[a-z0-9_-]{15,35}$'
    ORDER BY created_at DESC
  `);

  console.log(`Found ${res.rows.length} media assets to update with accurate titles.`);

  let updatedCount = 0;
  for (const row of res.rows) {
    const hash = extractHash(row.url);
    let originalName = hash ? map.get(hash) : null;

    if (!originalName) {
      if (hash === 'm79i8qbchnqbp2cevby8') {
        originalName = 'Rehearsal Recording - Monday 7th September 2026.mp3';
      } else if (hash === 'kol1paqqncnirrzvpucy') {
        originalName = 'Rehearsal Recording - Tuesday 8th September 2026.mp3';
      } else if (hash === 'sbjd2xk4gkgcvztezniq') {
        originalName = 'Rehearsal Recording - Wednesday 2nd September 2026.mp3';
      } else if (row.type === 'VIDEO') {
        originalName = `Loveworld Video - ${new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      } else {
        originalName = `Rehearsal Audio - ${hash}`;
      }
    }

    await pgClient.query(`
      UPDATE media_assets
      SET title = $1, updated_at = NOW()
      WHERE id = $2
    `, [originalName, row.id]);

    console.log(`✅ [${++updatedCount}/${res.rows.length}] ${row.id} -> "${originalName}"`);
  }

  console.log(`\n🎉 Successfully restored exact names for ${updatedCount} media assets!`);

  // Final verification
  const check = await pgClient.query(`
    SELECT COUNT(*) as remaining
    FROM media_assets
    WHERE title LIKE 'Rehearsal Audio Sep%'
       OR title ~ '^[a-z0-9_-]{15,35}$'
  `);
  console.log(`Remaining unformatted / hash titles: ${check.rows[0].remaining}`);

  await pgClient.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
