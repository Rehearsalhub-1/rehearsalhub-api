import 'dotenv/config';
import * as admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'loveworld-singers-app-firebase-adminsdk-fbsvc-bf26a96cba.json'), 'utf-8')
);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: 'loveworld-singers-app' });
const db = admin.firestore();

async function main() {
  const snap = await db.collection('subgroups').limit(5).get();
  snap.docs.forEach(doc => {
    console.log('\nDoc ID:', doc.id);
    console.log('Fields:', JSON.stringify(doc.data(), null, 2));
  });
  await admin.app().delete();
}
main().catch(console.error);
