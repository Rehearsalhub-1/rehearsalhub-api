const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function restore(backupFileName) {
  const backupDir = path.join(__dirname, '../backups');
  const fileToRestore = backupFileName
    ? path.join(backupDir, backupFileName)
    : path.join(backupDir, 'latest.json');

  if (!fs.existsSync(fileToRestore)) {
    console.error(`❌ Backup file not found: ${fileToRestore}`);
    process.exit(1);
  }

  console.log(`🔄 Restoring from snapshot: ${fileToRestore}`);
  const raw = fs.readFileSync(fileToRestore, 'utf8');
  const snapshot = JSON.parse(raw);

  console.log(`Snapshot Date: ${snapshot.timestamp}`);
  console.log('Tables included:', Object.keys(snapshot.tables || {}));

  // Restore program_songs junction table if needed
  if (Array.isArray(snapshot.tables?.program_songs)) {
    console.log(`Checking program_songs (${snapshot.tables.program_songs.length} rows in backup)...`);
    const currentCountRes = await pool.query('SELECT count(*) FROM program_songs');
    const currentCount = Number(currentCountRes.rows[0].count);
    console.log(`Current program_songs count: ${currentCount}`);

    if (currentCount < snapshot.tables.program_songs.length) {
      console.log('⚠️ Database has fewer program_songs than backup. Restoring missing links...');
      for (const ps of snapshot.tables.program_songs) {
        await pool.query(`
          INSERT INTO program_songs (id, program_id, song_id, "order")
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO NOTHING
        `, [ps.id, ps.program_id, ps.song_id, ps.order || 1]);
      }
      console.log('✅ Missing program_songs restored successfully.');
    } else {
      console.log('✅ program_songs is already fully populated.');
    }
  }

  console.log('🎉 Restore check complete!');
}

const arg = process.argv[2];
restore(arg)
  .catch((err) => {
    console.error('❌ Restore error:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
