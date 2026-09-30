import fs from 'fs';

const b1Obj: Record<string, any> = JSON.parse(fs.readFileSync('scripts/master_stems_backup.json', 'utf8'));
const b1: any[] = Object.entries(b1Obj).map(([id, val]) => ({ id, title: val.title, audioUrls: val.originalAudioUrls }));
const b2: any[] = JSON.parse(fs.readFileSync('scripts/master_stems_backup_phase2.json', 'utf8'));
const b3: any[] = JSON.parse(fs.readFileSync('scripts/master_stems_backup_phase3.json', 'utf8'));

console.log('Backup 1 songs count:', b1.length);
console.log('Backup 2 songs count:', b2.length);
console.log('Backup 3 songs count:', b3.length);

const countStems = (arr: any[]) => arr.filter(s => {
  if (!s.audioUrls || typeof s.audioUrls !== 'object') return false;
  const keys = Object.keys(s.audioUrls).filter(k => !k.startsWith('_') && k.toLowerCase() !== 'full');
  return keys.some(k => typeof s.audioUrls[k] === 'string' && s.audioUrls[k].trim().startsWith('http'));
}).length;

console.log('Songs with actual stems in B1 (initial state):', countStems(b1));
console.log('Songs with actual stems in B2:', countStems(b2));
console.log('Songs with actual stems in B3 (legitimate rehearsal stems):', countStems(b3));

