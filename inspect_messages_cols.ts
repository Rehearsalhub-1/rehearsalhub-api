import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  const msgCols = await sql`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'messages'
    ORDER BY ordinal_position;
  `;
  console.log('messages columns:', msgCols.map(c => `${c.column_name} (${c.data_type})`).join(', '));

  process.exit(0);
}
main().catch(console.error);
