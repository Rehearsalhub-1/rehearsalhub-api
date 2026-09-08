/**
 * Scanner script to extract all legacy Cloudinary URLs from the database.
 * Strictly scopes to official choir media assets, videos, and songs.
 * EXCLUDES all user personal media (member voice notes, doodles, personal practice).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const postgres = require('postgres');

const connectionString = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('ERROR: DATABASE_URL or DATABASE_ADMIN_URL is required.');
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: 'require',
  max: 4,
  prepare: false,
});

async function scan() {
  console.log('🔍 Scanning database for Cloudinary assets...');
  const assets = [];

  try {
    // 1. media_assets (official choir resources)
    console.log('  -> Scanning media_assets...');
    const mediaAssets = await sql`
      SELECT id, organization_id, group_id, title, url, thumbnail, type, folder, mime_type
      FROM media_assets
      WHERE url ILIKE '%cloudinary.com%' OR thumbnail ILIKE '%cloudinary.com%'
    `;
    console.log(`     Found ${mediaAssets.length} Cloudinary media_assets`);
    for (const m of mediaAssets) {
      if (m.url && m.url.includes('cloudinary.com')) {
        assets.push({
          table: 'media_assets',
          id: m.id,
          organizationId: m.organization_id || null,
          groupId: m.group_id || null,
          title: m.title,
          url: m.url,
          field: 'url',
          type: m.type,
          folder: m.folder || 'media',
        });
      }
      if (m.thumbnail && m.thumbnail.includes('cloudinary.com')) {
        assets.push({
          table: 'media_assets',
          id: m.id,
          organizationId: m.organization_id || null,
          groupId: m.group_id || null,
          title: `${m.title} (Thumbnail)`,
          url: m.thumbnail,
          field: 'thumbnail',
          type: 'IMAGE',
          folder: 'thumbnails',
        });
      }
    }

    // 2. zone_media_assets (if table exists)
    try {
      console.log('  -> Scanning zone_media_assets...');
      const zoneAssets = await sql`
        SELECT id, zone_id, title, url, type
        FROM zone_media_assets
        WHERE url ILIKE '%cloudinary.com%'
      `;
      console.log(`     Found ${zoneAssets.length} Cloudinary zone_media_assets`);
      for (const z of zoneAssets) {
        assets.push({
          table: 'zone_media_assets',
          id: z.id,
          organizationId: z.zone_id || null,
          title: z.title || 'Zone Media',
          url: z.url,
          field: 'url',
          type: z.type || 'AUDIO',
          folder: 'zone-media',
        });
      }
    } catch {
      console.log('     zone_media_assets table not present or empty.');
    }

    // 3. media_videos (choir rehearsal videos)
    try {
      console.log('  -> Scanning media_videos...');
      const videos = await sql`
        SELECT id, title, url, video_url, thumbnail
        FROM media_videos
        WHERE url ILIKE '%cloudinary.com%' 
           OR video_url ILIKE '%cloudinary.com%' 
           OR thumbnail ILIKE '%cloudinary.com%'
      `;
      console.log(`     Found ${videos.length} Cloudinary media_videos`);
      for (const v of videos) {
        const videoUrl = v.video_url || v.url;
        if (videoUrl && videoUrl.includes('cloudinary.com')) {
          assets.push({
            table: 'media_videos',
            id: v.id,
            title: v.title || 'Rehearsal Video',
            url: videoUrl,
            field: 'video_url',
            type: 'VIDEO',
            folder: 'videos',
          });
        }
        if (v.thumbnail && v.thumbnail.includes('cloudinary.com')) {
          assets.push({
            table: 'media_videos',
            id: v.id,
            title: `${v.title || 'Video'} (Thumbnail)`,
            url: v.thumbnail,
            field: 'thumbnail',
            type: 'IMAGE',
            folder: 'thumbnails',
          });
        }
      }
    } catch {
      console.log('     media_videos table not present or empty.');
    }

    // 4. songs (master songs audio_file & stems)
    console.log('  -> Scanning songs audio files & stems...');
    const songs = await sql`
      SELECT id, organization_id, title, audio_file, audio_urls
      FROM songs
      WHERE audio_file ILIKE '%cloudinary.com%'
         OR (audio_urls::text ILIKE '%cloudinary.com%')
    `;
    console.log(`     Found ${songs.length} songs with Cloudinary audio`);
    for (const s of songs) {
      if (s.audio_file && s.audio_file.includes('cloudinary.com')) {
        assets.push({
          table: 'songs',
          id: s.id,
          organizationId: s.organization_id || null,
          title: `${s.title} - Full Mix`,
          url: s.audio_file,
          field: 'audio_file',
          type: 'AUDIO',
          folder: 'songs',
        });
      }
      if (s.audio_urls && typeof s.audio_urls === 'object') {
        for (const [stemKey, stemUrl] of Object.entries(s.audio_urls)) {
          if (typeof stemUrl === 'string' && stemUrl.includes('cloudinary.com')) {
            assets.push({
              table: 'songs',
              id: s.id,
              organizationId: s.organization_id || null,
              title: `${s.title} - ${stemKey} Stem`,
              url: stemUrl,
              field: `audio_urls.${stemKey}`,
              type: 'AUDIO',
              folder: 'stems',
            });
          }
        }
      }
    }

    // Save to cloudinary_assets.json
    const outPath = path.join(__dirname, 'cloudinary_assets.json');
    fs.writeFileSync(outPath, JSON.stringify(assets, null, 2), 'utf8');
    console.log(`\n✅ Scan complete! Saved ${assets.length} official choir assets to: ${outPath}`);
  } catch (err) {
    console.error('Scan error:', err);
  } finally {
    await sql.end();
  }
}

scan();
