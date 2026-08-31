import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

const HQ_GROUP_IDS = new Set([
  'zone-001', 'zone-002', 'zone-003', 'zone-004', 'zone-005',
  'zone-orchestra', 'zone-president', 'zone-president-2',
  'zone-director', 'zone-oftp', 'zone-oftd',
  'zone-national', 'zone-international', 'zone-sa-1', 'zone-boss',
]);

const ZONES = [
  { id: 'zone-001', name: 'Your Loveworld Singers', code: 'ZONE001', region: 'Headquarters', invitationCode: 'ZONE001' },
  { id: 'zone-002', name: 'Loveworld Singers 24 Worship Band', code: 'ZONE002', region: 'Headquarters', invitationCode: 'ZONE002' },
  { id: 'zone-003', name: 'Loveworld Singers Children Choir', code: 'ZONE003', region: 'Headquarters', invitationCode: 'ZONE003' },
  { id: 'zone-004', name: 'Loveworld Singers Teens Choir', code: 'ZONE004', region: 'Headquarters', invitationCode: 'ZONE004' },
  { id: 'zone-005', name: 'Presidential Mass Choir', code: 'ZONE005', region: 'Headquarters', invitationCode: 'ZONE005' },
  { id: 'zone-orchestra', name: 'Loveworld Singers Orchestra', code: 'ZONEORCH', region: 'Headquarters', invitationCode: 'ZONEORCH' },
  { id: 'zone-president', name: 'The President Zone', code: 'ZONEPRES', region: 'Headquarters', invitationCode: 'ZONEPRES' },
  { id: 'zone-president-2', name: 'The President 2 Zone', code: 'ZONEPRES2', region: 'Headquarters', invitationCode: 'ZONEPRES2' },
  { id: 'zone-director', name: 'The Director Zone', code: 'ZONEDIR', region: 'Headquarters', invitationCode: 'ZONEDIR' },
  { id: 'zone-oftp', name: 'OFTP Pastors Zone', code: 'ZONEOFTP', region: 'Headquarters', invitationCode: 'ZONEOFTP' },
  { id: 'zone-oftd', name: 'Office of the Director', code: 'ZONEOFTD', region: 'Headquarters', invitationCode: 'ZONEOFTD' },
  { id: 'zone-national', name: 'Loveworld National Zonal Choir Representatives', code: 'ZONENAT', region: 'Headquarters', invitationCode: 'ZONENAT' },
  { id: 'zone-international', name: 'Loveworld International Zonal Choir Representatives', code: 'ZONEINT', region: 'Headquarters', invitationCode: 'ZONEINT' },
  { id: 'zone-sa-1', name: 'SA-1 President Audit Zone', code: 'ZONESA1', region: 'Headquarters', invitationCode: 'ZONESA1' },
  { id: 'zone-006', name: 'Loveworld Singers SA Zone 1', code: 'ZONE006', region: 'South Africa', invitationCode: 'ZONE006' },
  { id: 'zone-007', name: 'Loveworld Singers SA Zone 2', code: 'ZONE007', region: 'South Africa', invitationCode: 'ZONE007' },
  { id: 'zone-008', name: 'Loveworld Singers SA Zone 3', code: 'ZONE008', region: 'South Africa', invitationCode: 'ZONE008' },
  { id: 'zone-009', name: 'Loveworld Singers SA Zone 5', code: 'ZONE009', region: 'South Africa', invitationCode: 'ZONE009' },
  { id: 'zone-010', name: 'Loveworld Singers Durban Zone', code: 'ZONE010', region: 'South Africa', invitationCode: 'ZONE010' },
  { id: 'zone-011', name: 'Loveworld Singers Cape Town Zone 1', code: 'ZONE011', region: 'South Africa', invitationCode: 'ZONE011' },
  { id: 'zone-012', name: 'Loveworld Singers Cape Town Zone 2', code: 'ZONE012', region: 'South Africa', invitationCode: 'ZONE012' },
  { id: 'zone-013', name: 'Loveworld Singers India Zone', code: 'ZONE013', region: 'India', invitationCode: 'ZONE013' },
  { id: 'zone-014', name: 'Loveworld Singers Kenya Zone', code: 'ZONE014', region: 'Kenya', invitationCode: 'ZONE014' },
  { id: 'zone-015', name: 'Loveworld Singers Accra Ghana Zone', code: 'ZONE015', region: 'Ghana', invitationCode: 'ZONE015' },
  { id: 'zone-016', name: 'Loveworld Singers USA Region 1 Zone 1', code: 'ZONE016', region: 'USA', invitationCode: 'ZONE016' },
  { id: 'zone-017', name: 'Loveworld Singers USA Region 1 Zone 2', code: 'ZONE017', region: 'USA', invitationCode: 'ZONE017' },
  { id: 'zone-018', name: 'Loveworld Singers USA Region 2', code: 'ZONE018', region: 'USA', invitationCode: 'ZONE018' },
  { id: 'zone-019', name: 'Loveworld Singers USA Region 3', code: 'ZONE019', region: 'USA', invitationCode: 'ZONE019' },
  { id: 'zone-020', name: 'Loveworld Singers Ottawa Zone Canada', code: 'ZONE020', region: 'Canada', invitationCode: 'ZONE020' },
  { id: 'zone-021', name: 'Loveworld Singers Toronto Canada Zone', code: 'ZONE021', region: 'Canada', invitationCode: 'ZONE021' },
  { id: 'zone-022', name: 'Loveworld Singers Quebec Zone', code: 'ZONE022', region: 'Canada', invitationCode: 'ZONE022' },
  { id: 'zone-023', name: 'Loveworld Singers UK Zone 1 DSP', code: 'ZONE023', region: 'United Kingdom', invitationCode: 'ZONE023' },
  { id: 'zone-024', name: 'Loveworld Singers UK Zone 2 DSP', code: 'ZONE024', region: 'United Kingdom', invitationCode: 'ZONE024' },
  { id: 'zone-025', name: 'Loveworld Singers UK Zone 3 DSP', code: 'ZONE025', region: 'United Kingdom', invitationCode: 'ZONE025' },
  { id: 'zone-026', name: 'Loveworld Singers UK Zone 4 DSP', code: 'ZONE026', region: 'United Kingdom', invitationCode: 'ZONE026' },
  { id: 'zone-027', name: 'Loveworld Singers UK Region 2 Zone 1', code: 'ZONE027', region: 'United Kingdom', invitationCode: 'ZONE027' },
  { id: 'zone-028', name: 'Loveworld Singers UK Region 2 Zone 3', code: 'ZONE028', region: 'United Kingdom', invitationCode: 'ZONE028' },
  { id: 'zone-029', name: 'Loveworld Singers UK Region 2 Zone 4', code: 'ZONE029', region: 'United Kingdom', invitationCode: 'ZONE029' },
  { id: 'zone-030', name: 'Loveworld Singers Western Europe Zone 1', code: 'ZONE030', region: 'Western Europe', invitationCode: 'ZONE030' },
  { id: 'zone-031', name: 'Loveworld Singers Western Europe Zone 2', code: 'ZONE031', region: 'Western Europe', invitationCode: 'ZONE031' },
  { id: 'zone-032', name: 'Loveworld Singers Western Europe Zone 3', code: 'ZONE032', region: 'Western Europe', invitationCode: 'ZONE032' },
  { id: 'zone-033', name: 'Loveworld Singers Western Europe Zone 4', code: 'ZONE033', region: 'Western Europe', invitationCode: 'ZONE033' },
  { id: 'zone-034', name: 'Loveworld Singers Eastern Europe', code: 'ZONE034', region: 'Eastern Europe', invitationCode: 'ZONE034' },
  { id: 'zone-035', name: 'Loveworld Singers East Asia Region', code: 'ZONE035', region: 'East Asia', invitationCode: 'ZONE035' },
  { id: 'zone-036', name: 'Loveworld Singers Middle East and Asia', code: 'ZONE036', region: 'Middle East', invitationCode: 'ZONE036' },
  { id: 'zone-037', name: 'Loveworld Singers Australia', code: 'ZONE037', region: 'Australia', invitationCode: 'ZONE037' },
  { id: 'zone-038', name: 'Loveworld Singers South America NZ Pacific', code: 'ZONE038', region: 'South America', invitationCode: 'ZONE038' },
  { id: 'zone-039', name: 'Loveworld Singers Ministry Centre Abuja', code: 'ZONE039', region: 'Nigeria', invitationCode: 'ZONE039' },
  { id: 'zone-040', name: 'Loveworld Singers Ministry Centre Calabar', code: 'ZONE040', region: 'Nigeria', invitationCode: 'ZONE040' },
  { id: 'zone-041', name: 'Loveworld Singers Ministry Centre Abeokuta', code: 'ZONE041', region: 'Nigeria', invitationCode: 'ZONE041' },
  { id: 'zone-042', name: 'Loveworld Singers Ministry Centre Ibadan', code: 'ZONE042', region: 'Nigeria', invitationCode: 'ZONE042' },
  { id: 'zone-043', name: 'Loveworld Singers Warri Ministry Centre', code: 'ZONE043', region: 'Nigeria', invitationCode: 'ZONE043' },
  { id: 'zone-044', name: 'Loveworld Singers Lagos Zone 1', code: 'ZONE044', region: 'Nigeria', invitationCode: 'ZONE044' },
  { id: 'zone-045', name: 'Loveworld Singers Lagos Zone 2', code: 'ZONE045', region: 'Nigeria', invitationCode: 'ZONE045' },
  { id: 'zone-046', name: 'Loveworld Singers Lagos Zone 3', code: 'ZONE046', region: 'Nigeria', invitationCode: 'ZONE046' },
  { id: 'zone-047', name: 'Loveworld Singers Lagos Zone 4', code: 'ZONE047', region: 'Nigeria', invitationCode: 'ZONE047' },
  { id: 'zone-048', name: 'Loveworld Singers Lagos Zone 5', code: 'ZONE048', region: 'Nigeria', invitationCode: 'ZONE048' },
  { id: 'zone-049', name: 'Loveworld Singers Lagos Zone 6', code: 'ZONE049', region: 'Nigeria', invitationCode: 'ZONE049' },
  { id: 'zone-050', name: 'Loveworld Singers Lagos Sub Zone A', code: 'ZONE050', region: 'Nigeria', invitationCode: 'ZONE050' },
  { id: 'zone-051', name: 'Loveworld Singers Lagos Sub Zone B', code: 'ZONE051', region: 'Nigeria', invitationCode: 'ZONE051' },
  { id: 'zone-052', name: 'Loveworld Singers Lagos Sub Zone C', code: 'ZONE052', region: 'Nigeria', invitationCode: 'ZONE052' },
  { id: 'zone-053', name: 'Loveworld Singers Abuja Zone', code: 'ZONE053', region: 'Nigeria', invitationCode: 'ZONE053' },
  { id: 'zone-054', name: 'Loveworld Singers Aba Zone', code: 'ZONE054', region: 'Nigeria', invitationCode: 'ZONE054' },
  { id: 'zone-055', name: 'Loveworld Singers Ibadan Zone 1', code: 'ZONE055', region: 'Nigeria', invitationCode: 'ZONE055' },
  { id: 'zone-056', name: 'Loveworld Singers Onitsha Zone', code: 'ZONE056', region: 'Nigeria', invitationCode: 'ZONE056' },
  { id: 'zone-057', name: 'Loveworld Singers Port Harcourt Zone 1', code: 'ZONE057', region: 'Nigeria', invitationCode: 'ZONE057' },
  { id: 'zone-058', name: 'Loveworld Singers Port Harcourt Zone 2', code: 'ZONE058', region: 'Nigeria', invitationCode: 'ZONE058' },
  { id: 'zone-059', name: 'Loveworld Singers Port Harcourt Zone 3', code: 'ZONE059', region: 'Nigeria', invitationCode: 'ZONE059' },
  { id: 'zone-060', name: 'Loveworld Singers Warri DSC Sub Zone', code: 'ZONE060', region: 'Nigeria', invitationCode: 'ZONE060' },
  { id: 'zone-061', name: 'Loveworld Singers Nigeria North Central Zone 1', code: 'ZONE061', region: 'Nigeria', invitationCode: 'ZONE061' },
  { id: 'zone-062', name: 'Loveworld Singers Nigeria North Central Zone 2', code: 'ZONE062', region: 'Nigeria', invitationCode: 'ZONE062' },
  { id: 'zone-063', name: 'Loveworld Singers Nigeria North West Zone 1', code: 'ZONE063', region: 'Nigeria', invitationCode: 'ZONE063' },
  { id: 'zone-064', name: 'Loveworld Singers Nigeria North West Zone 2', code: 'ZONE064', region: 'Nigeria', invitationCode: 'ZONE064' },
  { id: 'zone-065', name: 'Loveworld Singers Nigeria North East Zone 1', code: 'ZONE065', region: 'Nigeria', invitationCode: 'ZONE065' },
  { id: 'zone-066', name: 'Loveworld Singers Nigeria South West Zone 2', code: 'ZONE066', region: 'Nigeria', invitationCode: 'ZONE066' },
  { id: 'zone-067', name: 'Loveworld Singers Nigeria South West Zone 3', code: 'ZONE067', region: 'Nigeria', invitationCode: 'ZONE067' },
  { id: 'zone-068', name: 'Loveworld Singers Nigeria South West Zone 4', code: 'ZONE068', region: 'Nigeria', invitationCode: 'ZONE068' },
  { id: 'zone-069', name: 'Loveworld Singers South West Zone 5', code: 'ZONE069', region: 'Nigeria', invitationCode: 'ZONE069' },
  { id: 'zone-070', name: 'Loveworld Singers Nigeria South South Zone 1', code: 'ZONE070', region: 'Nigeria', invitationCode: 'ZONE070' },
  { id: 'zone-071', name: 'Loveworld Singers Nigeria South South Zone 2', code: 'ZONE071', region: 'Nigeria', invitationCode: 'ZONE071' },
  { id: 'zone-072', name: 'Loveworld Singers Nigeria South South Zone 3', code: 'ZONE072', region: 'Nigeria', invitationCode: 'ZONE072' },
  { id: 'zone-073', name: 'Loveworld Singers Nigeria South East Zone 1', code: 'ZONE073', region: 'Nigeria', invitationCode: 'ZONE073' },
  { id: 'zone-074', name: 'Loveworld Singers Nigeria South East Zone 3', code: 'ZONE074', region: 'Nigeria', invitationCode: 'ZONE074' },
  { id: 'zone-075', name: 'Loveworld Singers Benin Zone 1', code: 'ZONE075', region: 'Nigeria', invitationCode: 'ZONE075' },
  { id: 'zone-076', name: 'Loveworld Singers Benin Zone 2', code: 'ZONE076', region: 'Nigeria', invitationCode: 'ZONE076' },
  { id: 'zone-077', name: 'Loveworld Singers Edo North Zone', code: 'ZONE077', region: 'Nigeria', invitationCode: 'ZONE077' },
  { id: 'zone-078', name: 'Loveworld Singers Midwest Zone', code: 'ZONE078', region: 'Nigeria', invitationCode: 'ZONE078' },
  { id: 'zone-079', name: 'Loveworld Singers EWCA Zone 1 Ethiopia', code: 'ZONE079', region: 'EWCA', invitationCode: 'ZONE079' },
  { id: 'zone-080', name: 'Loveworld Singers EWCA Zone 2', code: 'ZONE080', region: 'EWCA', invitationCode: 'ZONE080' },
  { id: 'zone-081', name: 'Loveworld Singers EWCA Zone 3', code: 'ZONE081', region: 'EWCA', invitationCode: 'ZONE081' },
  { id: 'zone-082', name: 'Loveworld Singers EWCA Zone 4', code: 'ZONE082', region: 'EWCA', invitationCode: 'ZONE082' },
  { id: 'zone-083', name: 'Loveworld Singers EWCA Zone 5', code: 'ZONE083', region: 'EWCA', invitationCode: 'ZONE083' },
  { id: 'zone-084', name: 'Loveworld Singers EWCA Zone 6', code: 'ZONE084', region: 'EWCA', invitationCode: 'ZONE084' },
  { id: 'zone-085', name: 'Loveworld Singers Chad Zone', code: 'ZONE085', region: 'Chad', invitationCode: 'ZONE085' },
  { id: 'zone-086', name: 'Loveworld Singers CELVZ', code: 'ZONE086', region: 'Special', invitationCode: 'ZONE086' },
  { id: 'zone-087', name: 'Loveworld Singers LGN', code: 'ZONE087', region: 'Special', invitationCode: 'ZONE087' },
  { id: 'zone-088', name: 'Special Duty Zone', code: 'ZONE088', region: 'Special', invitationCode: 'ZONE088' },
  { id: 'zone-089', name: 'CE Cape Town Zone 2', code: 'ZONE089', region: 'South Africa', invitationCode: 'ZONE089' },
  { id: 'zone-090', name: 'Special Zone', code: 'ZONE090', region: 'Special', invitationCode: 'ZONE090' },
  { id: 'zone-boss', name: 'Central Admin', code: 'BOSS101', region: 'Admin', invitationCode: 'BOSS101' },
];

async function main() {
  console.log('Seeding zones into database...');
  let count = 0;
  for (const zone of ZONES) {
    await prisma.organization.upsert({
      where: { id: zone.id },
      create: {
        id: zone.id,
        name: zone.name,
        code: zone.code,
        region: zone.region,
        invitationCode: zone.invitationCode,
        isHq: HQ_GROUP_IDS.has(zone.id),
        isActive: true,
      },
      update: {
        name: zone.name,
        code: zone.code,
        region: zone.region,
        invitationCode: zone.invitationCode,
        isHq: HQ_GROUP_IDS.has(zone.id),
      },
    });
    count++;
  }
  console.log(`Done — ${count} zones seeded.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
