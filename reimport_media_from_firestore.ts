import pg from 'pg';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const directUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!;
console.log('Connecting to PostgreSQL endpoint for Media reimport...');

const pool = new pg.Pool({
  connectionString: directUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
});

function parseTimestamp(raw: any, fallbackStr?: string): Date {
  if (raw && typeof raw === 'object' && typeof raw._seconds === 'number') {
    return new Date(raw._seconds * 1000);
  }
  if (fallbackStr) {
    const d = new Date(fallbackStr);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

async function main() {
  console.log('\n======================================================');
  console.log('  REIMPORTING MEDIA ASSETS FROM FIRESTORE EXPORT');
  console.log('======================================================\n');

  const snapshotFile = path.join(process.cwd(), 'backups', 'snapshot_1787937142839', 'media_assets.json');
  if (!fs.existsSync(snapshotFile)) {
    throw new Error(`Snapshot file not found at: ${snapshotFile}`);
  }

  const rawData: any[] = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  console.log(`✓ Loaded ${rawData.length} original media assets from Firestore export.\n`);

  console.log('Step 1: Dropping existing media_assets table in Supabase...');
  await pool.query(`DROP TABLE IF EXISTS media_assets CASCADE;`);
  console.log('✓ Dropped media_assets table.\n');

  console.log('Step 2: Creating fresh relational media_assets table...');
  await pool.query(`
    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      zone_id TEXT,
      subgroup_id TEXT,
      scope TEXT DEFAULT 'hq',
      title TEXT,
      type TEXT DEFAULT 'audio',
      folder TEXT,
      size BIGINT,
      mime_type TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      raw_data JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_media_assets_org ON media_assets(organization_id);
    CREATE INDEX IF NOT EXISTS idx_media_assets_zone ON media_assets(zone_id);
    CREATE INDEX IF NOT EXISTS idx_media_assets_type ON media_assets(type);
    CREATE INDEX IF NOT EXISTS idx_media_assets_folder ON media_assets(folder);
  `);
  console.log('✓ Created clean media_assets schema with indexes.\n');

  console.log(`Step 3: Inserting ${rawData.length} original Firestore media assets in batches...`);
  const batchSize = 400;
  let inserted = 0;

  for (let i = 0; i < rawData.length; i += batchSize) {
    const batch = rawData.slice(i, i + batchSize);
    const valuePlaceholders: string[] = [];
    const params: any[] = [];

    batch.forEach((m, idx) => {
      const raw = (m.raw_data && typeof m.raw_data === 'object') ? m.raw_data : {};
      const offset = idx * 13;
      valuePlaceholders.push(`(
        $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5},
        $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10},
        $${offset + 11}, $${offset + 12}, $${offset + 13}
      )`);

      const id = String(m.id || raw.id || `media_${Date.now()}_${idx}`);
      const zoneId = m.zone_id || raw.zoneId || raw.zone_id || null;
      const organizationId = m.organization_id || (zoneId === 'zone-001' ? 'zone-001' : null);
      const subgroupId = m.subgroup_id || raw.subgroupId || raw.sub_group_id || null;
      const scope = m.scope || (raw.forHQ || raw.for_hq ? 'hq' : 'zone');
      const title = raw.name || m.title || raw.title || 'Untitled Asset';
      
      const rawVideoUrl = String(raw.videoUrl || raw.video_url || raw.youtubeUrl || '');
      const isVideo = Boolean(
        rawVideoUrl ||
        raw.type === '2025-christmas-carol' ||
        raw.type === 'video' ||
        m.type === 'video' ||
        (raw.url && (raw.url.includes('.mp4') || raw.url.includes('youtube.com') || raw.url.includes('/videos/')))
      );
      const type = isVideo ? 'video' : (raw.type === 'image' || m.type === 'image' ? 'image' : 'audio');
      const folder = m.folder || raw.folder || (isVideo ? 'video' : 'audio');
      const size = typeof m.size === 'number' ? m.size : (typeof raw.size === 'number' ? raw.size : 0);
      const mimeType = m.mime_type || raw.mimeType || (isVideo ? 'video/mp4' : 'audio/mpeg');
      const createdAt = parseTimestamp(raw.createdAt, m.created_at);
      const updatedAt = parseTimestamp(raw.updatedAt, m.updated_at);

      params.push(
        id,
        organizationId,
        zoneId,
        subgroupId,
        scope,
        title,
        type,
        folder,
        size,
        mimeType,
        createdAt,
        updatedAt,
        JSON.stringify(raw)
      );
    });

    await pool.query(`
      INSERT INTO media_assets (
        id, organization_id, zone_id, subgroup_id, scope,
        title, type, folder, size, mime_type,
        created_at, updated_at, raw_data
      ) VALUES ${valuePlaceholders.join(', ')}
      ON CONFLICT (id) DO NOTHING;
    `, params);

    inserted += batch.length;
    process.stdout.write(`\r  Progress: ${inserted} / ${rawData.length} (${Math.round((inserted / rawData.length) * 100)}%)`);
  }

  console.log('\n\n✓ Successfully reimported all original Firestore media assets!');

  const countRes = await pool.query('SELECT count(*)::int as count FROM media_assets');
  console.log(`✓ Verified total live media_assets count: ${countRes.rows[0].count}`);

  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
