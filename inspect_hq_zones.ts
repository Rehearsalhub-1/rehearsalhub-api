import prisma from './src/lib/prisma';

async function main() {
  const zones = await prisma.zone.findMany();
  console.log('=== ZONES ===');
  zones.forEach(z => {
    const raw = (z.rawData || {}) as any;
    console.log(`- ID: ${z.id} | Name: ${z.name} | Code: ${z.code} | isHQ: ${(z as any).isHq ?? raw.isHq ?? raw.is_hq} | Type: ${(z as any).type ?? raw.type}`);
  });

  const orgs = await prisma.organization.findMany();
  console.log('\n=== ORGANIZATIONS ===');
  orgs.forEach(o => {
    const raw = (o.rawData || {}) as any;
    console.log(`- ID: ${o.id} | Name: ${o.name} | Code: ${o.code} | isHQ: ${(o as any).isHq ?? raw.isHq ?? raw.is_hq} | Type: ${(o as any).type ?? raw.type}`);
  });

  const sub = await prisma.subgroup.findMany();
  console.log('\n=== SUBGROUPS / HQ GROUPS ===');
  sub.forEach(s => {
    const raw = (s.rawData || {}) as any;
    console.log(`- ID: ${s.id} | Name: ${s.name} | ZoneId: ${s.zoneId} | isHQ: ${(s as any).isHq ?? raw.isHq ?? raw.is_hq}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
