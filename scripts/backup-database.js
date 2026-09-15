const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function backup() {
  console.log('🔄 Starting automated database backup...');
  const backupDir = path.join(__dirname, '../backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `backup_${timestamp}.json`);

  const tables = [
    'programs',
    'songs',
    'program_songs',
    'song_history',
    'organizations',
    'groups',
    'media_assets',
  ];

  const data = {
    timestamp: new Date().toISOString(),
    counts: {},
    tables: {},
  };

  for (const table of tables) {
    try {
      const res = await pool.query(`SELECT * FROM "${table}"`);
      data.tables[table] = res.rows;
      data.counts[table] = res.rows.length;
      console.log(`  ✅ ${table.padEnd(16)}: ${res.rows.length} rows`);
    } catch (err) {
      console.warn(`  ⚠️ Could not export ${table}:`, err.message);
    }
  }

  fs.writeFileSync(backupFile, JSON.stringify(data, null, 2), 'utf8');
  console.log(`\n🎉 Backup saved successfully to:\n   ${backupFile}`);

  // Also maintain a "latest.json" for fast restore
  const latestFile = path.join(backupDir, 'latest.json');
  fs.writeFileSync(latestFile, JSON.stringify(data, null, 2), 'utf8');
  console.log(`   (Latest copy updated at ${latestFile})`);
}

backup()
  .catch((err) => {
    console.error('❌ Backup failed:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
