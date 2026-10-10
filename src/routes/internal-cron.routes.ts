
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { checkR2ObjectExists } from '../services/r2Service';

const router = Router();

function isoDateAfter(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

router.post('/daily-reminders', async (req: Request, res: Response) => {
  const configuredSecret = process.env.CRON_SECRET;
  const suppliedSecret = req.headers['x-cron-secret'];
  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const targetDate = isoDateAfter(1);
    const events = await prisma.program.findMany({
      where: {
        date: targetDate,
      },
    });

    let generatedCount = 0;

    for (const event of events) {
      const orgId = event.organizationId || 'zone-001';
      const notifId = `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const title = `Reminder: ${event.name || 'Upcoming Rehearsal'}`;
      const message = `You have ${event.name || 'an upcoming rehearsal'} tomorrow (${targetDate}).`;

      await prisma.notification.create({
        data: {
          id: notifId,
          title,
          body: message,
          type: 'reminder',
          category: 'schedule',
          priority: 'normal',
          organizationId: orgId,
        },
      });
      generatedCount++;
    }

    res.json({ success: true, targetDate, generatedCount });
  } catch (err) {
    console.error('[internal-cron:daily-reminders]', err);
    res.status(500).json({ success: false, error: 'Failed to generate daily reminders' });
  }
});

// ─── Audit: count Railway proxy URLs across all media columns ─────────────────
// GET /internal/audit-urls?secret=<API_SECRET_KEY>
// READ-ONLY. Returns counts of Railway / Cloudinary / R2-direct URLs per table.
// Cloudinary URLs are flagged but NOT touched — manual migration only.
router.get('/audit-urls', async (req: Request, res: Response) => {
  const apiSecret = process.env.API_SECRET_KEY;
  const suppliedSecret = req.query.secret;
  if (!apiSecret || suppliedSecret !== apiSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const RAILWAY = 'railway.app/upload/file';
  const R2 = 'r2.dev';
  const CLOUDINARY = 'res.cloudinary.com';

  function classify(url: string | null | undefined) {
    if (!url) return 'empty';
    if (url.includes(RAILWAY)) return 'railway';
    if (url.includes(CLOUDINARY)) return 'cloudinary';
    if (url.includes(R2)) return 'r2_direct';
    return 'other';
  }

  function tally(rows: Array<string | null | undefined>) {
    const counts = { railway: 0, cloudinary: 0, r2_direct: 0, other: 0, empty: 0 };
    const railwaySamples: string[] = [];
    for (const url of rows) {
      const k = classify(url) as keyof typeof counts;
      counts[k]++;
      if (k === 'railway' && railwaySamples.length < 3 && url) railwaySamples.push(url);
    }
    return { ...counts, railwaySamples };
  }

  try {
    const report: Record<string, any> = {};

    // songs.audio_file
    const songs = await prisma.song.findMany({ select: { id: true, audioFile: true, audioUrls: true } });
    report['songs.audio_file'] = tally(songs.map(s => s.audioFile));

    // songs.audio_urls (JSON stems)
    const stemUrls: (string | null)[] = [];
    for (const s of songs) {
      if (s.audioUrls && typeof s.audioUrls === 'object') {
        for (const v of Object.values(s.audioUrls as Record<string, any>)) {
          if (typeof v === 'string') stemUrls.push(v);
        }
      }
    }
    report['songs.audio_urls(stems)'] = tally(stemUrls);

    // profiles.avatar_url
    const profiles = await prisma.user.findMany({ select: { avatarUrl: true } });
    report['profiles.avatar_url'] = tally(profiles.map(p => p.avatarUrl));

    // programs.banner_image
    const programs = await prisma.program.findMany({ select: { bannerImage: true } });
    report['programs.banner_image'] = tally(programs.map(p => p.bannerImage));

    // categories.image
    const cats = await prisma.category.findMany({ select: { image: true } });
    report['categories.image'] = tally(cats.map(c => c.image));

    // media_assets.url + thumbnail
    const assets = await prisma.mediaAsset.findMany({ select: { url: true, thumbnail: true } });
    report['media_assets.url'] = tally(assets.map(a => a.url));
    report['media_assets.thumbnail'] = tally(assets.map(a => a.thumbnail));

    // submitted_songs.audio_url
    const submitted = await prisma.submittedSong.findMany({ select: { audioUrl: true } });
    report['submitted_songs.audio_url'] = tally(submitted.map(s => s.audioUrl));

    // user_statuses.media_url
    const statuses = await prisma.userStatus.findMany({ select: { mediaUrl: true } });
    report['user_statuses.media_url'] = tally(statuses.map(s => s.mediaUrl));

    // calls.caller_avatar
    const calls = await prisma.call.findMany({ select: { callerAvatar: true } });
    report['calls.caller_avatar'] = tally(calls.map(c => c.callerAvatar));

    // Grand totals
    let totalRailway = 0, totalCloudinary = 0, totalR2 = 0;
    for (const v of Object.values(report)) {
      totalRailway += (v as any).railway;
      totalCloudinary += (v as any).cloudinary;
      totalR2 += (v as any).r2_direct;
    }

    res.json({
      success: true,
      summary: { totalRailway, totalCloudinary, totalR2 },
      breakdown: report,
    });
  } catch (err: any) {
    console.error('[internal:audit-urls]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Migrate Railway proxy URLs → R2 direct URLs ──────────────────────────────
// POST /internal/cron/migrate-railway-urls?secret=<API_SECRET_KEY>
// Add ?dryRun=true to preview without touching the DB.
// Skips all Cloudinary URLs — those are manual only.
router.post('/migrate-railway-urls', async (req: Request, res: Response) => {
  const apiSecret = process.env.API_SECRET_KEY;
  const suppliedSecret = req.query.secret;
  if (!apiSecret || suppliedSecret !== apiSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const dryRun = req.query.dryRun === 'true';
  const RAILWAY_PREFIX = 'https://rehearsalhub-api-production-6a17.up.railway.app/upload/file/';
  const R2_PREFIX = 'https://pub-cb7697578fcc48d3b3aeb70a47eb2f65.r2.dev/';

  function toR2(url: string): string {
    return url.replace(RAILWAY_PREFIX, R2_PREFIX);
  }

  const results: Record<string, any> = {};
  let totalUpdated = 0;
  let totalSkipped = 0;

  try {
    // ── 1. songs.audio_file ──────────────────────────────────────────────────
    if (!dryRun) {
      const r = await prisma.$executeRaw`
        UPDATE songs
        SET audio_file = REPLACE(audio_file, ${RAILWAY_PREFIX}, ${R2_PREFIX})
        WHERE audio_file LIKE ${'%' + RAILWAY_PREFIX + '%'}
      `;
      results['songs.audio_file'] = { updated: r };
      totalUpdated += r;
    } else {
      const count = await prisma.song.count({
        where: { audioFile: { contains: RAILWAY_PREFIX } },
      });
      results['songs.audio_file'] = { wouldUpdate: count };
      totalUpdated += count;
    }

    // ── 2. songs.audio_urls (JSON stems) ─────────────────────────────────────
    const songsWithRailway = await prisma.song.findMany({
      where: {},
      select: { id: true, audioUrls: true },
    });

    let stemUpdated = 0;
    let stemSkipped = 0;
    for (const song of songsWithRailway) {
      if (!song.audioUrls || typeof song.audioUrls !== 'object') continue;
      const stems = song.audioUrls as Record<string, any>;
      let changed = false;
      const newStems: Record<string, any> = {};
      for (const [k, v] of Object.entries(stems)) {
        if (typeof v === 'string' && v.includes(RAILWAY_PREFIX)) {
          newStems[k] = toR2(v);
          changed = true;
        } else {
          newStems[k] = v;
        }
      }
      if (changed) {
        if (!dryRun) {
          await prisma.song.update({
            where: { id: song.id },
            data: { audioUrls: newStems },
          });
        }
        stemUpdated++;
      } else {
        stemSkipped++;
      }
    }
    results['songs.audio_urls(stems)'] = dryRun
      ? { wouldUpdate: stemUpdated, skipped: stemSkipped }
      : { updated: stemUpdated, skipped: stemSkipped };
    totalUpdated += stemUpdated;
    totalSkipped += stemSkipped;

    // ── 3. users.avatar_url ──────────────────────────────────────────────────
    if (!dryRun) {
      const r = await prisma.$executeRaw`
        UPDATE profiles
        SET avatar_url = REPLACE(avatar_url, ${RAILWAY_PREFIX}, ${R2_PREFIX})
        WHERE avatar_url LIKE ${'%' + RAILWAY_PREFIX + '%'}
      `;
      results['users.avatar_url'] = { updated: r };
      totalUpdated += r;
    } else {
      const count = await prisma.user.count({
        where: { avatarUrl: { contains: RAILWAY_PREFIX } },
      });
      results['users.avatar_url'] = { wouldUpdate: count };
      totalUpdated += count;
    }

    // ── 4. programs.banner_image ─────────────────────────────────────────────
    if (!dryRun) {
      const r = await prisma.$executeRaw`
        UPDATE programs
        SET banner_image = REPLACE(banner_image, ${RAILWAY_PREFIX}, ${R2_PREFIX})
        WHERE banner_image LIKE ${'%' + RAILWAY_PREFIX + '%'}
      `;
      results['programs.banner_image'] = { updated: r };
      totalUpdated += r;
    } else {
      const count = await prisma.program.count({
        where: { bannerImage: { contains: RAILWAY_PREFIX } },
      });
      results['programs.banner_image'] = { wouldUpdate: count };
      totalUpdated += count;
    }

    // ── 5. media_assets.url ──────────────────────────────────────────────────
    if (!dryRun) {
      const r = await prisma.$executeRaw`
        UPDATE media_assets
        SET url = REPLACE(url, ${RAILWAY_PREFIX}, ${R2_PREFIX})
        WHERE url LIKE ${'%' + RAILWAY_PREFIX + '%'}
      `;
      results['media_assets.url'] = { updated: r };
      totalUpdated += r;
    } else {
      const count = await prisma.mediaAsset.count({
        where: { url: { contains: RAILWAY_PREFIX } },
      });
      results['media_assets.url'] = { wouldUpdate: count };
      totalUpdated += count;
    }

    res.json({
      success: true,
      dryRun,
      summary: {
        totalUpdated,
        totalSkipped,
        r2Prefix: R2_PREFIX,
      },
      breakdown: results,
    });
  } catch (err: any) {
    console.error('[internal:migrate-railway-urls]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Export zone-001 Cloudinary songs as CSV ─────────────────────────────────
// GET /internal/cron/export-songs-csv?secret=<API_SECRET_KEY>&program_name=<NAME>&program_id=<ID>
// Only exports songs in Loveworld Singers HQ (zone-001) Programs that have Cloudinary URLs to replace.
// Grouped and sorted by Program Name, Program Date, then song order.
// Side-by-side columns: Current Cloudinary URL next to Paste R2 URL.
router.get('/export-songs-csv', async (req: Request, res: Response) => {
  const apiSecret = process.env.API_SECRET_KEY;
  if (!apiSecret || req.query.secret !== apiSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  function csvCell(val: string | null | undefined): string {
    const s = (val ?? '').toString();
    return `"${s.replace(/"/g, '""')}"`;
  }

  try {
    const CLOUDINARY = 'res.cloudinary.com';

    const programWhere: Record<string, any> = {
      organizationId: 'zone-001',
    };

    if (req.query.program_id) {
      programWhere.id = String(req.query.program_id);
    } else if (req.query.program_name) {
      programWhere.name = { contains: String(req.query.program_name), mode: 'insensitive' };
    }

    const programSongs = await prisma.programSong.findMany({
      where: {
        program: programWhere,
      },
      include: {
        program: {
          select: {
            id: true,
            name: true,
            date: true,
            category: true,
          },
        },
        song: {
          select: {
            id: true,
            title: true,
            leadSinger: true,
            conductor: true,
            category: true,
            audioFile: true,
            audioUrls: true,
          },
        },
      },
      orderBy: [
        { program: { name: 'asc' } },
        { order: 'asc' },
        { song: { title: 'asc' } },
      ],
    });

    const rows: string[] = [];

    // Header with side-by-side traceability
    rows.push([
      'PROGRAM_NAME',
      'PROGRAM_DATE',
      'SONG_TITLE',
      'LEAD_SINGER',
      'CONDUCTOR',
      'song_id',
      // Main Audio
      'PASTE_R2_MAIN_AUDIO',
      'current_cloudinary_main_audio',
      // Full mix stem
      'PASTE_R2_STEM_FULL',
      'current_cloudinary_stem_full',
      // Band stem
      'PASTE_R2_STEM_BAND',
      'current_cloudinary_stem_band',
      // Lead vocals stem
      'PASTE_R2_STEM_LEAD_VOCALS',
      'current_cloudinary_stem_lead_vocals',
      // Backup vocals stem
      'PASTE_R2_STEM_BACKUP_VOCALS',
      'current_cloudinary_stem_backup_vocals',
      // Tenor stem
      'PASTE_R2_STEM_TENOR',
      'current_cloudinary_stem_tenor',
      // Alto stem
      'PASTE_R2_STEM_ALTO',
      'current_cloudinary_stem_alto',
      // Soprano stem
      'PASTE_R2_STEM_SOPRANO',
      'current_cloudinary_stem_soprano',
    ].map(csvCell).join(','));

    for (const ps of programSongs) {
      const song = ps.song;
      if (!song) continue;

      const audio = song.audioFile ?? '';
      const stems = (song.audioUrls && typeof song.audioUrls === 'object')
        ? song.audioUrls as Record<string, any>
        : {};

      const stemFull   = String(stems['full'] ?? stems['FULL'] ?? '');
      const stemBand   = String(stems['BAND'] ?? stems['band'] ?? stems['Band'] ?? '');
      const stemLead   = String(stems['LEAD VOCALS'] ?? stems['lead_vocals'] ?? stems['LEAD_VOCALS'] ?? stems['Lead'] ?? stems['BAND & LEAD VOCALS'] ?? '');
      const stemBackup = String(stems['BACKUP VOCALS'] ?? stems['backup_vocals'] ?? stems['BACKUP_VOCALS'] ?? stems['Backup Vocals'] ?? stems['BAND & BACKUP VOCALS'] ?? '');
      const stemTenor  = String(stems['tenor'] ?? stems['Tenor'] ?? '');
      const stemAlto   = String(stems['alto'] ?? stems['Alto'] ?? '');
      const stemSoprano= String(stems['soprano'] ?? stems['Soprano'] ?? '');

      const hasCloudinary =
        audio.includes(CLOUDINARY) ||
        stemFull.includes(CLOUDINARY) ||
        stemBand.includes(CLOUDINARY) ||
        stemLead.includes(CLOUDINARY) ||
        stemBackup.includes(CLOUDINARY) ||
        stemTenor.includes(CLOUDINARY) ||
        stemAlto.includes(CLOUDINARY) ||
        stemSoprano.includes(CLOUDINARY);

      if (!hasCloudinary) continue;

      const formatUrl = (url: string) => {
        if (!url) return '';
        if (url.includes(CLOUDINARY)) return url;
        return '(already R2)';
      };

      rows.push([
        ps.program.name,
        ps.program.date ?? '',
        song.title,
        song.leadSinger ?? '',
        song.conductor ?? '',
        song.id,
        // Main Audio
        '', formatUrl(audio),
        // Stems
        '', formatUrl(stemFull),
        '', formatUrl(stemBand),
        '', formatUrl(stemLead),
        '', formatUrl(stemBackup),
        '', formatUrl(stemTenor),
        '', formatUrl(stemAlto),
        '', formatUrl(stemSoprano),
      ].map(csvCell).join(','));
    }

    const csv = rows.join('\r\n');
    const safeProgName = req.query.program_name
      ? `_${String(req.query.program_name).replace(/[^a-zA-Z0-9]/g, '_')}`
      : '';
    const filename = `lws_hq_programs${safeProgName}_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);
  } catch (err: any) {
    console.error('[internal:export-songs-csv]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── List all R2 files in zones/zone-001/ as CSV reference ───────────────────
// GET /internal/cron/export-r2-files?secret=<API_SECRET_KEY>
// Sheet 2 of 2: All files already uploaded to R2 for zone-001.
// Team copies R2 URLs from here and pastes into the songs CSV above.
router.get('/export-r2-files', async (req: Request, res: Response) => {
  const apiSecret = process.env.API_SECRET_KEY;
  if (!apiSecret || req.query.secret !== apiSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  function csvCell(val: string | null | undefined): string {
    const s = (val ?? '').toString();
    return `"${s.replace(/"/g, '""')}"`;
  }

  try {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const { r2Client, publicUrlBase } = await import('../services/r2Service');
    const bucketName = process.env.R2_BUCKET_NAME || 'rehearsalhub-media';
    const R2_PREFIX = 'zones/zone-001/';

    const rows: string[] = [];
    rows.push(['filename', 'folder', 'r2_url', 'size_kb'].map(csvCell).join(','));

    let continuationToken: string | undefined;
    let totalFiles = 0;

    do {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: R2_PREFIX,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      });

      const resp = await r2Client.send(command);

      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue;
        const parts = obj.Key.split('/');
        const filename = parts[parts.length - 1];
        const folder   = parts.slice(0, -1).join('/');
        const url      = `${publicUrlBase}/${obj.Key}`;
        const sizeKb   = obj.Size ? Math.round(obj.Size / 1024) : 0;

        rows.push([filename, folder, url, sizeKb.toString()].map(csvCell).join(','));
        totalFiles++;
      }

      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    const csv = rows.join('\r\n');
    const filename = `zone001_r2_files_reference_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv);
  } catch (err: any) {
    console.error('[internal:export-r2-files]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── Import completed CSV to update Cloudinary → R2 URLs ─────────────────────
// POST /internal/cron/import-songs-csv?secret=<API_SECRET_KEY>
// Body: raw CSV text (Content-Type: text/plain or text/csv)
// Only rows where NEW_AUDIO_URL or NEW_STEM_* columns are filled will be updated.
// Rows with empty new URL columns are skipped safely.
router.post('/import-songs-csv', async (req: Request, res: Response) => {
  const apiSecret = process.env.API_SECRET_KEY;
  if (!apiSecret || req.query.secret !== apiSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body: string = typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

    if (!body || body.trim().length === 0) {
      res.status(400).json({ success: false, error: 'No CSV body provided. Send raw CSV as request body.' });
      return;
    }

    // Simple CSV parser — handles quoted fields with commas and escaped quotes
    function parseCSV(text: string): string[][] {
      const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      return lines.map(line => {
        const fields: string[] = [];
        let i = 0;
        while (i < line.length) {
          if (line[i] === '"') {
            let val = '';
            i++; // skip opening quote
            while (i < line.length) {
              if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
              else if (line[i] === '"') { i++; break; }
              else { val += line[i++]; }
            }
            fields.push(val);
            if (line[i] === ',') i++;
          } else {
            const end = line.indexOf(',', i);
            if (end === -1) { fields.push(line.slice(i)); break; }
            fields.push(line.slice(i, end));
            i = end + 1;
          }
        }
        return fields;
      }).filter(r => r.some(c => c.trim()));
    }

    const rows = parseCSV(body);
    if (rows.length < 2) {
      res.status(400).json({ success: false, error: 'CSV has no data rows.' });
      return;
    }

    // Map header names to column indexes (supports multiple aliases)
    const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'));
    const col = (...names: string[]) => {
      for (const n of names) {
        const idx = headers.indexOf(n);
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const IDX = {
      id:           col('song_id', 'id'),
      newAudio:     col('paste_r2_main_audio', 'new_audio_url', 'paste_r2_url_here', 'new_audio'),
      newFull:      col('paste_r2_stem_full', 'new_stem_full', 'stem_full_paste_r2_url'),
      newBand:      col('paste_r2_stem_band', 'new_stem_band', 'stem_band_paste_r2_url'),
      newLead:      col('paste_r2_stem_lead_vocals', 'new_stem_lead_vocals', 'stem_lead_paste_r2_url', 'paste_r2_stem_lead'),
      newBackup:    col('paste_r2_stem_backup_vocals', 'new_stem_backup_vocals', 'stem_backup_paste_r2_url', 'paste_r2_stem_backup'),
      newTenor:     col('paste_r2_stem_tenor', 'new_stem_tenor'),
      newAlto:      col('paste_r2_stem_alto', 'new_stem_alto'),
      newSoprano:   col('paste_r2_stem_soprano', 'new_stem_soprano'),
    };

    if (IDX.id === -1) {
      res.status(400).json({ success: false, error: 'CSV missing required column: song_id' });
      return;
    }

    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const songId    = row[IDX.id]?.trim();
      const newAudio  = IDX.newAudio   !== -1 ? row[IDX.newAudio]?.trim()   : '';
      const newFull   = IDX.newFull    !== -1 ? row[IDX.newFull]?.trim()    : '';
      const newBand   = IDX.newBand    !== -1 ? row[IDX.newBand]?.trim()    : '';
      const newLead   = IDX.newLead    !== -1 ? row[IDX.newLead]?.trim()    : '';
      const newBackup = IDX.newBackup  !== -1 ? row[IDX.newBackup]?.trim()  : '';
      const newTenor  = IDX.newTenor   !== -1 ? row[IDX.newTenor]?.trim()   : '';
      const newAlto   = IDX.newAlto    !== -1 ? row[IDX.newAlto]?.trim()    : '';
      const newSoprano= IDX.newSoprano !== -1 ? row[IDX.newSoprano]?.trim() : '';

      if (!songId) { skipped++; continue; }

      // Skip rows where nothing new was entered or if someone pasted placeholders
      const isValidUrl = (url: string) => url.startsWith('http://') || url.startsWith('https://');

      const validAudio   = isValidUrl(newAudio)   ? newAudio   : '';
      const validFull    = isValidUrl(newFull)    ? newFull    : '';
      const validBand    = isValidUrl(newBand)    ? newBand    : '';
      const validLead    = isValidUrl(newLead)    ? newLead    : '';
      const validBackup  = isValidUrl(newBackup)  ? newBackup  : '';
      const validTenor   = isValidUrl(newTenor)   ? newTenor   : '';
      const validAlto    = isValidUrl(newAlto)    ? newAlto    : '';
      const validSoprano = isValidUrl(newSoprano) ? newSoprano : '';

      const hasAny = validAudio || validFull || validBand || validLead || validBackup || validTenor || validAlto || validSoprano;
      if (!hasAny) { skipped++; continue; }

      try {
        const existing = await prisma.song.findUnique({
          where: { id: songId },
          select: { id: true, audioUrls: true },
        });
        if (!existing) { errors.push(`Row ${i + 1}: song_id "${songId}" not found`); continue; }

        const updateData: Record<string, any> = {};

        if (validAudio) updateData.audioFile = validAudio;

        if (validFull || validBand || validLead || validBackup || validTenor || validAlto || validSoprano) {
          const stems = (existing.audioUrls && typeof existing.audioUrls === 'object')
            ? { ...(existing.audioUrls as Record<string, any>) }
            : {};
          if (validFull)    { stems['full'] = validFull; stems['FULL'] = validFull; }
          if (validBand)    { stems['BAND'] = validBand; stems['band'] = validBand; stems['Band'] = validBand; }
          if (validLead)    { stems['LEAD VOCALS'] = validLead; stems['lead_vocals'] = validLead; stems['Lead'] = validLead; }
          if (validBackup)  { stems['BACKUP VOCALS'] = validBackup; stems['backup_vocals'] = validBackup; stems['Backup Vocals'] = validBackup; }
          if (validTenor)   { stems['tenor'] = validTenor; stems['Tenor'] = validTenor; }
          if (validAlto)    { stems['alto'] = validAlto; stems['Alto'] = validAlto; }
          if (validSoprano) { stems['soprano'] = validSoprano; stems['Soprano'] = validSoprano; }
          updateData.audioUrls = stems;
        }

        await prisma.song.update({ where: { id: songId }, data: updateData });
        updated++;
      } catch (rowErr: any) {
        errors.push(`Row ${i + 1} (${songId}): ${rowErr.message}`);
      }
    }

    res.json({
      success: true,
      summary: { updated, skipped, errors: errors.length },
      errors: errors.slice(0, 20), // show first 20 errors max
    });
  } catch (err: any) {
    console.error('[internal:import-songs-csv]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Auto clock-in for developer/owner ───────────────────────────────────────
// POST /internal/cron/auto-clockin
// Called by a scheduled job once daily at 10 AM.
// Clocks in the owner if a clock-in session is open for their zone today.
const AUTO_CLOCKIN_USER_ID = '8ILWjbl9IbgbuxBK9P23mB6pZBt1';

router.post('/auto-clockin', async (req: Request, res: Response) => {
  const configuredSecret = process.env.CRON_SECRET;
  const suppliedSecret = req.headers['x-cron-secret'];
  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    // Find the user's active zone
    const membership = await prisma.membership.findFirst({
      where: { userId: AUTO_CLOCKIN_USER_ID, status: 'ACTIVE' },
      select: { organizationId: true },
    });

    if (!membership?.organizationId) {
      return res.json({ success: false, reason: 'No active zone membership found' });
    }

    const orgId = membership.organizationId;

    // Check if clock-in session is open for this zone
    const sessionKey = `clockin_session_${orgId}`;
    const sessionSetting = await prisma.setting.findUnique({ where: { key: sessionKey } });
    const sessionVal: any = sessionSetting?.value || {};

    if (sessionVal.isOpen === false) {
      return res.json({ success: false, reason: 'Clock-in session is closed — no rehearsal today' });
    }

    // Check if already clocked in today
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const existingToday = await prisma.attendance.findFirst({
      where: {
        userId: AUTO_CLOCKIN_USER_ID,
        OR: [
          { checkInTime: { gte: startOfDay, lte: endOfDay } },
          { createdAt:   { gte: startOfDay, lte: endOfDay } },
        ],
      },
    });

    if (existingToday) {
      return res.json({ success: false, reason: 'Already clocked in today', recordId: existingToday.id });
    }

    // Get event name from geofence activeEventName if set by coordinator
    const candidateGeoKeys = [`geofence_${orgId}`, 'geofence'];
    const geoSettings = await prisma.setting.findMany({ where: { key: { in: candidateGeoKeys } } });
    const geoVal: any = geoSettings.find(s => s.key === `geofence_${orgId}`)?.value
      || geoSettings.find(s => s.key === 'geofence')?.value
      || {};

    const eventName = (typeof geoVal?.activeEventName === 'string' && geoVal.activeEventName.trim())
      || 'General Rehearsal';

    // Find active program for this zone (optional — attach if exists)
    const activeProgram = await prisma.program.findFirst({
      where: { organizationId: orgId, isActive: true },
      select: { id: true },
    });

    // Clock in
    const id = `att_auto_${crypto.randomUUID()}`;
    const inserted = await prisma.attendance.create({
      data: {
        id,
        organizationId: orgId,
        userId: AUTO_CLOCKIN_USER_ID,
        programId: activeProgram?.id || null,
        eventName,
        status: 'present',
        checkInTime: now,
        recordedById: AUTO_CLOCKIN_USER_ID,
      },
    });

    return res.json({ success: true, message: 'Auto clock-in successful', recordId: inserted.id, eventName, orgId });
  } catch (err: any) {
    console.error('[internal:auto-clockin]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
