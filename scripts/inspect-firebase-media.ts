import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'loveworld-singers-app',
  });
}

const db = admin.firestore();

async function inspectMedia() {
  console.log('=== Inspecting cloudinary_media ===');
  const snap1 = await db.collection('cloudinary_media').limit(3).get();
  snap1.forEach((doc) => {
    console.log('cloudinary_media doc:', doc.id, JSON.stringify(doc.data(), null, 2));
  });

  console.log('\n=== Inspecting zone_cloudinary_media ===');
  const snap2 = await db.collection('zone_cloudinary_media').limit(3).get();
  snap2.forEach((doc) => {
    console.log('zone_cloudinary_media doc:', doc.id, JSON.stringify(doc.data(), null, 2));
  });

  await admin.app().delete();
}

inspectMedia().catch(console.error);
