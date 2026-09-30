const pg = require('pg');
const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:NbbVWLUsYpkiRsVpPBpIqsBcnvwoVMjS@altaria.proxy.rlwy.net:29756/railway?sslmode=no-verify',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  try {
    const res = await pool.query("SELECT * FROM user_song_notes LIMIT 20");
    console.log('user_song_notes count:', res.rowCount);
    console.log(JSON.stringify(res.rows, null, 2));

    const total = await pool.query("SELECT COUNT(*) FROM user_song_notes");
    console.log('Total user_song_notes:', total.rows[0].count);
  } catch(e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}
check();
