import { prisma } from '../src/lib/prisma';
import admin from 'firebase-admin';

// Initialize Firebase if credentials exist
let db: FirebaseFirestore.Firestore | null = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(cred),
    });
    db = admin.firestore();
  } else {
    // Check default app or standard path
    if (admin.apps.length === 0) {
      admin.initializeApp();
    }
    db = admin.firestore();
  }
} catch (e: any) {
  console.log('Firebase init error:', e.message);
}

async function main() {
  if (!db) {
    console.log('No firestore DB available');
    return;
  }

  // Get a few programs from Firestore
  console.log('Querying firestore programs...');
  const snap = await db.collection('programs').limit(5).get();
  console.log('Found firestore programs:', snap.size);
  snap.forEach(doc => {
    const data = doc.data();
    console.log('Doc ID:', doc.id, 'Title:', data.title || data.name);
    console.log('Keys:', Object.keys(data));
    if (data.songs) console.log('songs count:', Array.isArray(data.songs) ? data.songs.length : typeof data.songs);
    if (data.songIds) console.log('songIds count:', Array.isArray(data.songIds) ? data.songIds.length : typeof data.songIds);
    if (data.programSongs) console.log('programSongs count:', Array.isArray(data.programSongs) ? data.programSongs.length : typeof data.programSongs);
  });

  // Also check if there is a 'praiseNights' collection
  const pnSnap = await db.collection('praiseNights').limit(5).get();
  console.log('\nFound firestore praiseNights:', pnSnap.size);
  pnSnap.forEach(doc => {
    const data = doc.data();
    console.log('Doc ID:', doc.id, 'Title:', data.title || data.name);
    console.log('Keys:', Object.keys(data));
    if (data.songs) console.log('songs count:', Array.isArray(data.songs) ? data.songs.length : typeof data.songs);
  });

  // Check subcollections for one program
  if (!snap.empty) {
    const firstDoc = snap.docs[0];
    const subcols = await firstDoc.ref.listCollections();
    console.log('\nSubcollections for first program:', subcols.map(c => c.id));
  }

  process.exit(0);
}

main().catch(console.error);
