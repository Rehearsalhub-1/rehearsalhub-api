import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  for (const t of ['users', 'profiles', 'zone_members', 'subgroup_members', 'zone_songs', 'subgroup_songs', 'zone_programs', 'subgroup_programs']) {
    const exists = await sql`SELECT to_regclass(${'public.' + t}) as tbl;`;
    if (exists[0]?.tbl) {
      const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${t};`;
      console.log(`Table "${t}" columns:`, cols.map(c => c.column_name).join(', '));
    }
  }
  process.exit(0);
}
main().catch(console.error);
