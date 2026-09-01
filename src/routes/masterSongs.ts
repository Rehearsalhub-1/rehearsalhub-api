import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

function requireMasterEditor(req: Request, res: Response, next: any): void {
  const role = String(res.locals.auth?.role || '').toLowerCase();
  if (role !== 'hq_admin' && role !== 'admin' && role !== 'super_admin' && role !== 'org_admin') {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }
  next();
}

// GET /master-songs — Returns the 822 official Public Master Songs
router.get('/', async (_req: Request, res: Response) => {
  try {
    const songs = await prisma.song.findMany({
      where: {
        isMaster: true,
      },
      orderBy: { title: 'asc' },
    });

    const formattedSongs = songs.map((s) => ({
      id: s.id,
      title: s.title || '',
      key: s.key || null,
      tempo: s.tempo || null,
      lyrics: s.lyrics || null,
      writer: s.writer || null,
      solfas: s.solfas || null,
      category: s.category || 'Master Library',
      audioFile: s.audioFile || null,
      audioUrls: s.audioUrls || (s.audioFile ? { full: s.audioFile } : null),
      conductor: s.conductor || null,
      leadSinger: s.leadSinger || null,
      drummer: s.drummer || null,
      bassGuitarist: s.bassGuitarist || null,
      leadKeyboardist: s.leadKeyboardist || null,
      leadGuitarist: s.leadGuitarist || null,
      status: s.status || 'active',
      isMaster: true,
      isMinistered: s.isMinistered,
      rehearsalCount: s.rehearsalCount,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    res.json({ success: true, count: formattedSongs.length, data: formattedSongs });
  } catch (error) {
    console.error('Error fetching master songs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch master songs' });
  }
});

// GET /master-songs/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const song = await prisma.song.findUnique({ where: { id: req.params.id } });
    if (!song) return res.status(404).json({ success: false, error: 'Song not found' });
    res.json({ success: true, data: song });
  } catch (error) {
    console.error('Error fetching song:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch song' });
  }
});

// POST /master-songs
router.post('/', requireAuth, requireMasterEditor, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const songId = body.id || `master_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const row = await prisma.song.create({
      data: {
        id: songId,
        title: body.title || 'Untitled Master Song',
        key: body.key || null,
        tempo: body.tempo || null,
        lyrics: body.lyrics || null,
        writer: body.writer || null,
        category: body.category || 'Master Library',
        audioFile: body.audioFile || body.audio_file || null,
        audioUrls: body.audioUrls || body.audio_urls || null,
        conductor: body.conductor || null,
        leadSinger: body.leadSinger || body.lead_singer || null,
        drummer: body.drummer || null,
        bassGuitarist: body.bassGuitarist || body.bass_guitarist || null,
        leadKeyboardist: body.leadKeyboardist || body.lead_keyboardist || null,
        leadGuitarist: body.leadGuitarist || body.lead_guitarist || null,
        solfas: body.solfas || body.solfa || null,
        isMaster: true,
        isMinistered: true,
        status: body.status || 'active',
      },
    });

    res.status(201).json({ success: true, message: 'Master song created', data: row });
  } catch (err) {
    console.error('[master POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create master song' });
  }
});

// PATCH /master-songs/:id
router.patch('/:id', requireAuth, requireMasterEditor, async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Master song not found' });

    const data: Record<string, any> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.writer !== undefined) data.writer = body.writer;
    if (body.category !== undefined) data.category = body.category;
    if (body.audioFile !== undefined || body.audio_file !== undefined) data.audioFile = body.audioFile || body.audio_file;
    if (body.audioUrls !== undefined || body.audio_urls !== undefined) data.audioUrls = body.audioUrls || body.audio_urls;
    if (body.conductor !== undefined) data.conductor = body.conductor;
    if (body.leadSinger !== undefined || body.lead_singer !== undefined) data.leadSinger = body.leadSinger || body.lead_singer;
    if (body.drummer !== undefined) data.drummer = body.drummer;
    if (body.bassGuitarist !== undefined || body.bass_guitarist !== undefined) data.bassGuitarist = body.bassGuitarist || body.bass_guitarist;
    if (body.leadKeyboardist !== undefined || body.lead_keyboardist !== undefined) data.leadKeyboardist = body.leadKeyboardist || body.lead_keyboardist;
    if (body.leadGuitarist !== undefined || body.lead_guitarist !== undefined) data.leadGuitarist = body.leadGuitarist || body.lead_guitarist;
    if (body.solfas !== undefined || body.solfa !== undefined) data.solfas = body.solfas || body.solfa;
    if (body.status !== undefined) data.status = body.status;

    const updated = await prisma.song.update({ where: { id: songId }, data });
    res.json({ success: true, message: 'Master song updated', data: updated });
  } catch (err) {
    console.error('[master PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update master song' });
  }
});

// DELETE /master-songs/:id
router.delete('/:id', requireAuth, requireMasterEditor, async (req: Request, res: Response) => {
  try {
    await prisma.song.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Master song deleted' });
  } catch (err) {
    console.error('[master DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete master song' });
  }
});

export default router;
