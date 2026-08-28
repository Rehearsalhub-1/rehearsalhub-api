import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  console.log('=== EXECUTING 5-CORE DATABASE CONSOLIDATION ===\n');

  // =========================================================================
  // STEP 1: Consolidate Profiles & Members
  // =========================================================================
  console.log('--- Step 1: Consolidating Profiles & Members ---');

  // Backfill from users table into profiles
  await sql`
    INSERT INTO profiles (id, email, name, role, zone_id, status, created_at, updated_at)
    SELECT DISTINCT ON (id)
      id, 
      COALESCE(email, id || '@member.rehearsalhub.org'), 
      COALESCE(email, 'Member'),
      COALESCE(role, 'member'),
      COALESCE(zone_id, 'zone-001'),
      'active',
      COALESCE(created_at, NOW()),
      NOW()
    FROM users
    ON CONFLICT (id) DO UPDATE SET
      email = COALESCE(profiles.email, EXCLUDED.email),
      role = COALESCE(NULLIF(profiles.role, 'member'), EXCLUDED.role, 'member'),
      zone_id = COALESCE(profiles.zone_id, EXCLUDED.zone_id);
  `;

  // Backfill from zone_members
  await sql`
    INSERT INTO profiles (id, email, name, role, zone_id, status, created_at, updated_at)
    SELECT DISTINCT ON (COALESCE(user_id, id))
      COALESCE(user_id, id),
      COALESCE(user_email, raw_data->>'email', id || '@member.rehearsalhub.org'),
      COALESCE(user_name, raw_data->>'name', 'Zone Member'),
      COALESCE(role, 'member'),
      COALESCE(zone_id, 'zone-001'),
      COALESCE(status, 'active'),
      COALESCE(created_at, NOW()),
      NOW()
    FROM zone_members
    ORDER BY COALESCE(user_id, id), created_at DESC
    ON CONFLICT (id) DO UPDATE SET
      name = COALESCE(NULLIF(profiles.name, ''), EXCLUDED.name),
      zone_id = COALESCE(profiles.zone_id, EXCLUDED.zone_id),
      status = COALESCE(profiles.status, EXCLUDED.status);
  `;

  // Backfill from subgroup_members
  await sql`
    INSERT INTO profiles (id, email, name, role, subgroup_id, church_id, status, created_at, updated_at)
    SELECT DISTINCT ON (COALESCE(user_id, id))
      COALESCE(user_id, id),
      COALESCE(raw_data->>'email', id || '@church.rehearsalhub.org'),
      COALESCE(raw_data->>'name', 'Church Singer'),
      COALESCE(role, 'member'),
      subgroup_id,
      subgroup_id,
      COALESCE(status, 'active'),
      COALESCE(created_at, NOW()),
      NOW()
    FROM subgroup_members
    ORDER BY COALESCE(user_id, id), created_at DESC
    ON CONFLICT (id) DO UPDATE SET
      subgroup_id = COALESCE(profiles.subgroup_id, EXCLUDED.subgroup_id),
      church_id = COALESCE(profiles.church_id, EXCLUDED.church_id),
      name = COALESCE(NULLIF(profiles.name, ''), EXCLUDED.name);
  `;

  const profileCount = await sql`SELECT count(*) as count FROM profiles;`;
  console.log(`✓ Profiles unified: ${profileCount[0].count} total records.`);

  // =========================================================================
  // STEP 2: Consolidate Songs
  // =========================================================================
  console.log('\n--- Step 2: Consolidating Songs ---');

  // Backfill from zone_songs
  await sql`
    INSERT INTO songs (
      id, title, writer, lead_singer, audio_file, audio_urls, key, tempo, conductor, drummer,
      scope, zone_id, category, raw_data, created_at, updated_at
    )
    SELECT DISTINCT ON (id)
      id,
      COALESCE(title, raw_data->>'title', 'Untitled Song'),
      COALESCE(writer, raw_data->>'writer', ''),
      COALESCE(lead_singer, raw_data->>'leadSinger', ''),
      COALESCE(audio_file, raw_data->>'audioFile', raw_data->>'audioUrl', ''),
      COALESCE(audio_urls, raw_data->'audioUrls', '{}'::jsonb),
      COALESCE(key, raw_data->>'key', ''),
      COALESCE(tempo, raw_data->>'tempo', ''),
      COALESCE(conductor, raw_data->>'conductor', ''),
      COALESCE(drummer, raw_data->>'drummer', ''),
      'zone',
      COALESCE(zone_id, raw_data->>'zoneId', 'zone-001'),
      COALESCE(category, 'Zone Song'),
      COALESCE(raw_data, '{}'::jsonb),
      COALESCE(created_at, NOW()),
      NOW()
    FROM zone_songs
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      scope = 'zone',
      zone_id = EXCLUDED.zone_id,
      lead_singer = COALESCE(NULLIF(songs.lead_singer, ''), EXCLUDED.lead_singer),
      audio_file = COALESCE(NULLIF(songs.audio_file, ''), EXCLUDED.audio_file);
  `;

  // Backfill from subgroup_songs
  await sql`
    INSERT INTO songs (
      id, title, writer, lead_singer, audio_file, audio_urls, key, tempo,
      scope, zone_id, subgroup_id, category, raw_data, created_at, updated_at
    )
    SELECT DISTINCT ON (id)
      id,
      COALESCE(title, raw_data->>'title', 'Church Song'),
      COALESCE(writer, raw_data->>'writer', ''),
      COALESCE(lead_singer, raw_data->>'leadSinger', ''),
      COALESCE(audio_file, raw_data->>'audioFile', ''),
      COALESCE(audio_urls, raw_data->'audioUrls', '{}'::jsonb),
      COALESCE(key, raw_data->>'key', ''),
      COALESCE(tempo, raw_data->>'tempo', ''),
      'subgroup',
      COALESCE(zone_id, 'zone-001'),
      sub_group_id,
      COALESCE(category, 'Church Repertoire'),
      COALESCE(raw_data, '{}'::jsonb),
      COALESCE(created_at, NOW()),
      NOW()
    FROM subgroup_songs
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      scope = 'subgroup',
      subgroup_id = EXCLUDED.subgroup_id,
      lead_singer = COALESCE(NULLIF(songs.lead_singer, ''), EXCLUDED.lead_singer),
      audio_file = COALESCE(NULLIF(songs.audio_file, ''), EXCLUDED.audio_file);
  `;

  // Backfill from ministered_songs
  await sql`
    INSERT INTO songs (
      id, title, writer, lead_singer, conductor, audio_file, lyrics, key, tempo,
      scope, is_ministered, category, raw_data, created_at, updated_at
    )
    SELECT DISTINCT ON (id)
      id,
      COALESCE(title, raw_data->>'title', 'Ministered Song'),
      COALESCE(writer, raw_data->>'writer', ''),
      COALESCE(lead_singer, raw_data->>'leadSinger', ''),
      COALESCE(conductor, raw_data->>'conductor', ''),
      COALESCE(audio_file, raw_data->>'audioFile', raw_data->>'audioUrl', ''),
      COALESCE(lyrics, raw_data->>'lyrics', ''),
      COALESCE(key, raw_data->>'key', ''),
      COALESCE(tempo, raw_data->>'tempo', ''),
      'hq',
      true,
      'Ministered Songs',
      COALESCE(raw_data, '{}'::jsonb),
      NOW(),
      NOW()
    FROM ministered_songs
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      is_ministered = true,
      lead_singer = COALESCE(NULLIF(songs.lead_singer, ''), EXCLUDED.lead_singer),
      audio_file = COALESCE(NULLIF(songs.audio_file, ''), EXCLUDED.audio_file);
  `;

  const songCount = await sql`SELECT count(*) as count FROM songs;`;
  console.log(`✓ Songs unified: ${songCount[0].count} total records.`);

  // =========================================================================
  // STEP 3: Consolidate Programs & Rehearsals
  // =========================================================================
  console.log('\n--- Step 3: Consolidating Programs & Rehearsals ---');

  // Backfill from zone_programs
  await sql`
    INSERT INTO programs (
      id, name, date, location, scope, category, status, zone_id, banner_image, song_ids, songs, raw_data, created_at, updated_at
    )
    SELECT DISTINCT ON (id)
      id,
      COALESCE(name, raw_data->>'name', 'Zonal Rehearsal'),
      COALESCE(date::text, raw_data->>'date', NOW()::text),
      COALESCE(location, raw_data->>'location'),
      'zone',
      COALESCE(category, raw_data->>'category', 'rehearsal'),
      COALESCE(status, raw_data->>'status', 'ongoing'),
      COALESCE(zone_id, raw_data->>'zoneId', 'zone-001'),
      COALESCE(banner_image, raw_data->>'bannerImage', raw_data->>'imageUrl'),
      COALESCE(song_ids, raw_data->'songIds', '[]'::jsonb),
      COALESCE(songs, raw_data->'songs', '[]'::jsonb),
      COALESCE(raw_data, '{}'::jsonb),
      COALESCE(created_at, NOW()),
      NOW()
    FROM zone_programs
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      scope = 'zone',
      zone_id = EXCLUDED.zone_id,
      song_ids = EXCLUDED.song_ids,
      songs = EXCLUDED.songs;
  `;

  // Backfill from subgroup_programs
  await sql`
    INSERT INTO programs (
      id, name, date, location, scope, category, status, zone_id, subgroup_id, banner_image, song_ids, songs, raw_data, created_at, updated_at
    )
    SELECT DISTINCT ON (id)
      id,
      COALESCE(name, raw_data->>'name', 'Church Rehearsal'),
      COALESCE(date::text, raw_data->>'date', NOW()::text),
      COALESCE(location, raw_data->>'location'),
      'subgroup',
      'church',
      COALESCE(status, category, 'ongoing'),
      COALESCE(zone_id, 'zone-001'),
      sub_group_id,
      COALESCE(banner_image, raw_data->>'bannerImage'),
      COALESCE(song_ids, raw_data->'songIds', '[]'::jsonb),
      COALESCE(songs, raw_data->'songs', '[]'::jsonb),
      COALESCE(raw_data, '{}'::jsonb),
      COALESCE(created_at, NOW()),
      NOW()
    FROM subgroup_programs
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      scope = 'subgroup',
      subgroup_id = EXCLUDED.subgroup_id,
      song_ids = EXCLUDED.song_ids,
      songs = EXCLUDED.songs;
  `;

  const progCount = await sql`SELECT count(*) as count FROM programs;`;
  console.log(`✓ Programs unified: ${progCount[0].count} total records.`);

  // =========================================================================
  // STEP 4: Consolidate Media Assets
  // =========================================================================
  console.log('\n--- Step 4: Consolidating Media Assets ---');

  // Backfill from zone_media_assets
  await sql`
    INSERT INTO media_assets (
      id, title, scope, zone_id, type, raw_data
    )
    SELECT DISTINCT ON (id)
      id,
      COALESCE(raw_data->>'name', raw_data->>'title', 'Zone Media Asset'),
      'zone',
      COALESCE(raw_data->>'zoneId', raw_data->>'zone_id', 'zone-001'),
      'audio',
      COALESCE(raw_data, '{}'::jsonb)
    FROM zone_media_assets
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      scope = 'zone',
      zone_id = EXCLUDED.zone_id;
  `;

  // Backfill from media_videos
  await sql`
    INSERT INTO media_assets (
      id, title, scope, type, raw_data
    )
    SELECT DISTINCT ON (id)
      id,
      COALESCE(title, raw_data->>'title', 'Video Asset'),
      'hq',
      'video',
      COALESCE(raw_data, '{}'::jsonb)
    FROM media_videos
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      type = 'video';
  `;

  const mediaCount = await sql`SELECT count(*) as count FROM media_assets;`;
  console.log(`✓ Media assets unified: ${mediaCount[0].count} total records.`);

  // =========================================================================
  // STEP 5: Consolidate Categories
  // =========================================================================
  console.log('\n--- Step 5: Consolidating Categories ---');

  await sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS name TEXT;`;

  // Backfill from zone_categories
  await sql`
    INSERT INTO categories (id, name, scope, zone_id, type, raw_data)
    SELECT DISTINCT ON (id)
      id,
      COALESCE(raw_data->>'name', raw_data->>'title', 'Zone Category'),
      'zone',
      COALESCE(raw_data->>'zoneId', raw_data->>'zone_id', 'zone-001'),
      'program',
      COALESCE(raw_data, '{}'::jsonb)
    FROM zone_categories
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      scope = 'zone',
      zone_id = EXCLUDED.zone_id;
  `;

  // Backfill from media_categories
  await sql`
    INSERT INTO categories (id, name, scope, type, raw_data)
    SELECT DISTINCT ON (id)
      id,
      COALESCE(raw_data->>'name', raw_data->>'title', 'Media Category'),
      'hq',
      'media',
      COALESCE(raw_data, '{}'::jsonb)
    FROM media_categories
    ORDER BY id
    ON CONFLICT (id) DO UPDATE SET
      type = 'media';
  `;

  const catCount = await sql`SELECT count(*) as count FROM categories;`;
  console.log(`✓ Categories unified: ${catCount[0].count} total records.`);

  console.log('\n======================================================');
  console.log('5-CORE DATABASE CONSOLIDATION COMPLETED SUCCESSFULLY!');
  console.log(`- Profiles: ${profileCount[0].count}`);
  console.log(`- Songs: ${songCount[0].count}`);
  console.log(`- Programs: ${progCount[0].count}`);
  console.log(`- Media Assets: ${mediaCount[0].count}`);
  console.log(`- Categories: ${catCount[0].count}`);
  console.log('======================================================');

  process.exit(0);
}

main().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
