
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';

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

export default router;
