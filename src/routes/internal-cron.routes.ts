
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

export default router;
