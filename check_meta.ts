import prisma from './src/lib/prisma';

async function main() {
  // Check settings/meta for leadership accounts
  const leadershipIds = [
    'k9Sq3qAj1VU7SHsEuRBW1HG73Rn1', // president@loveworldhq.org
    'KDZxCv9DTTbVuzw30D8CbOf2FV52',  // thepresident2@loveworld.com
    'g789qDZ3tvSYeJRccFog01UqVtI3',  // director@loveworldhq.org
  ];

  for (const uid of leadershipIds) {
    const user = await prisma.user.findUnique({ where: { id: uid } });
    const meta = await prisma.setting.findUnique({ where: { key: `profile_meta_${uid}` } });
    console.log({
      email: user?.email,
      metaKey: meta?.key,
      metaValue: meta?.value,
    });
  }

  // Also check all settings with hiddenFeatures
  const settings = await prisma.setting.findMany({
    where: {
      key: { startsWith: 'profile_meta_' }
    },
    take: 20
  });
  console.log('\n=== All profile_meta settings ===');
  settings.forEach(s => {
    const val = s.value as any;
    if (val && (val.hiddenFeatures || val.hideArchives !== undefined || val.canAccessArchive !== undefined)) {
      console.log({ key: s.key, value: val });
    }
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
