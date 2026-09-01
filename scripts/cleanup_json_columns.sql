-- cleanup_json_columns.sql
--
-- Run this ONLY after wire_relationships.ts has completed successfully
-- and you have verified that program_songs + playlist_items counts are correct.
--
-- Verification query to run BEFORE this script:
--   SELECT p.name,
--          jsonb_array_length(COALESCE(p.song_ids, '[]'::jsonb)) AS json_count,
--          count(ps.song_id) AS linked_count
--   FROM programs p
--   LEFT JOIN program_songs ps ON ps.program_id = p.id
--   WHERE p.song_ids IS NOT NULL
--   GROUP BY p.id, p.name, p.song_ids
--   HAVING jsonb_array_length(COALESCE(p.song_ids, '[]'::jsonb)) != count(ps.song_id)
--   LIMIT 10;
-- Expected: 0 rows (all songs matched, except ghost references which are expected)

-- -----------------------------------------------------------------------------
-- STEP 1: Remove redundant JSON columns from programs
-- -----------------------------------------------------------------------------
ALTER TABLE programs DROP COLUMN IF EXISTS song_ids;
ALTER TABLE programs DROP COLUMN IF EXISTS songs;

-- -----------------------------------------------------------------------------
-- STEP 2: Remove the old reverse FK on songs (relationship now in program_songs)
-- -----------------------------------------------------------------------------
ALTER TABLE songs DROP COLUMN IF EXISTS praise_night_id;

-- -----------------------------------------------------------------------------
-- STEP 3: Remove redundant JSON columns from playlists
-- -----------------------------------------------------------------------------
ALTER TABLE playlists DROP COLUMN IF EXISTS song_ids;
ALTER TABLE playlists DROP COLUMN IF EXISTS songs;

-- -----------------------------------------------------------------------------
-- STEP 4: Confirm final structure
-- -----------------------------------------------------------------------------
SELECT 'program_songs' AS table_name, count(*) AS rows FROM program_songs
UNION ALL
SELECT 'playlist_items', count(*) FROM playlist_items
UNION ALL
SELECT 'programs', count(*) FROM programs
UNION ALL
SELECT 'songs', count(*) FROM songs
UNION ALL
SELECT 'playlists', count(*) FROM playlists;
