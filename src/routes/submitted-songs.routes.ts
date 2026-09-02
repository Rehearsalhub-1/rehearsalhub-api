import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function shapeSubmission(s: any) {
  const isPending = (s.status || '').toLowerCase() === 'pending';
  const isApproved = (s.status || '').toLowerCase() === 'approved';
  const isRejected = (s.status || '').toLowerCase() === 'rejected';

  return {
    id: s.id,
    userId: s.groupId || s.organizationId || null,
    userName: s.writer || 'Member',
    userEmail: '',
    userAvatar: null,
    title: s.title || 'Untitled Song',
    artist: s.writer || null,
    writer: s.writer || null,
    lyrics: s.lyrics || '',
    audioUrl: s.audioFile || null,
    audioFile: s.audioFile || null,
    category: s.category || 'Submitted Songs',
    key: s.key || null,
    tempo: s.tempo || null,
    solfas: s.solfas || null,
    leadSinger: s.leadSinger || null,
    conductor: s.conductor || null,
    notes: '',
    rejectNotes: null,
    status: isApproved ? 'approved' : (isRejected ? 'rejected' : 'pending'),
    organizationId: s.organizationId || 'zone-001',
    zoneId: s.organizationId || 'zone-001',
    zoneName: s.organization?.name || s.organizationId || null,
    submittedBy: { name: s.writer || 'Member' },
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** GET /submitted-songs — List submissions */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { status, zoneId } = req.query as Record<string, string>;
    const targetZone = zoneId || req.tenant?.effectiveZoneId;

    const where: any = {
      OR: [
        { category: 'Submitted Songs' },
        { status: { in: ['pending', 'approved', 'rejected'] } },
      ],
    };

    if (status && status !== 'all') {
      where.status = status.toLowerCase();
    }

    if (targetZone && targetZone !== 'all' && targetZone !== 'global') {
      where.organizationId = targetZone;
    }

    const songs = await prisma.song.findMany({
      where,
      include: { organization: true },
      orderBy: { createdAt: 'desc' },
      take: 250,
    });

    res.json({ success: true, count: songs.length, data: songs.map(shapeSubmission) });
  } catch (err) {
    console.error('[submitted-songs:get]', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

/** GET /submitted-songs/mine */
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const userId = auth?.userId;

    const songs = await prisma.song.findMany({
      where: {
        category: 'Submitted Songs',
      },
      include: { organization: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json({ success: true, count: songs.length, data: songs.map(shapeSubmission) });
  } catch (err) {
    console.error('[submitted-songs:mine]', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

/** POST /submitted-songs — Create song submission */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const { title, lyrics, notes, audioUrl, artist, writer, category, key, tempo, solfas, zoneId } = req.body;
    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    if (orgId) {
      try {
        await prisma.organization.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
      } catch {}
    }

    const created = await prisma.song.create({
      data: {
        id,
        title: title || 'Untitled Submitted Song',
        writer: writer || artist || auth.firstName || 'Member',
        key: key || null,
        tempo: tempo || null,
        lyrics: lyrics || null,
        solfas: solfas || null,
        category: category || 'Submitted Songs',
        audioFile: audioUrl || null,
        status: 'pending',
        organizationId: orgId,
      },
      include: { organization: true },
    });

    const formatted = shapeSubmission(created);
    broadcast('submitted_song', id, formatted);
    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[submitted-songs:post]', err);
    res.status(500).json({ success: false, error: 'Failed to submit song' });
  }
});

/** PATCH /submitted-songs/:id/approve */
router.patch('/:id/approve', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updated = await prisma.song.update({
      where: { id },
      data: { status: 'approved' },
      include: { organization: true },
    });

    const formatted = shapeSubmission(updated);
    broadcast('submitted_song', id, formatted);
    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[submitted-songs:approve]', err);
    res.status(500).json({ success: false, error: 'Failed to approve song' });
  }
});

/** PATCH /submitted-songs/:id/reject */
router.patch('/:id/reject', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updated = await prisma.song.update({
      where: { id },
      data: { status: 'rejected' },
      include: { organization: true },
    });

    const formatted = shapeSubmission(updated);
    broadcast('submitted_song', id, formatted);
    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[submitted-songs:reject]', err);
    res.status(500).json({ success: false, error: 'Failed to reject song' });
  }
});

/** PATCH /submitted-songs/:id — Update song submission */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Submission not found' });

    const data: Record<string, any> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.writer !== undefined) data.writer = body.writer;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.solfas !== undefined) data.solfas = body.solfas;
    if (body.audioUrl !== undefined || body.audioFile !== undefined) data.audioFile = body.audioUrl || body.audioFile;
    if (body.status !== undefined) data.status = body.status;

    const updated = await prisma.song.update({
      where: { id },
      data,
      include: { organization: true },
    });

    const formatted = shapeSubmission(updated);
    broadcast('submitted_song', id, formatted);
    res.json({ success: true, message: 'Submission updated', data: formatted });
  } catch (err) {
    console.error('[submitted-songs:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update submission' });
  }
});

export default router;
