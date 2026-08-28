import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { mergeRawRow } from '../lib/rawRow';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

function requireMasterEditor(req: Request, res: Response, next: any): void {
  const role = String(res.locals.auth?.role || '').toLowerCase();
  if (role !== 'hq_admin' && role !== 'admin') {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }
  next();
}

// GET /master-songs
router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.song.findMany({
      where: {
        OR: [
          { isMinistered: true },
          { category: 'Ministered Songs' },
          { organizationId: 'zone-001' },
        ],
      },
      orderBy: { title: 'asc' },
    });

    const songs = rows.map((r) => {
      const m = mergeRawRow(r);
      return {
        id: String(m.id),
        title: typeof m.title === 'string' ? m.title : '',
        key: typeof m.key === 'string' ? m.key : null,
        tempo: typeof m.tempo === 'string' ? m.tempo : null,
        lyrics: typeof m.lyrics === 'string' ? m.lyrics : null,
        writer: typeof m.writer === 'string' ? m.writer : null,
        solfa: typeof m.solfa === 'string' ? m.solfa : null,
        category: typeof m.category === 'string' ? m.category : null,
        categories: Array.isArray(m.categories) ? m.categories : (m.category ? [m.category] : []),
        imageUrl: typeof m.imageUrl === 'string' ? m.imageUrl : null,
        audioFile: typeof m.audioFile === 'string' ? m.audioFile : null,
        audioUrls: m.audioUrls && typeof m.audioUrls === 'object' ? m.audioUrls : null,
        conductor: typeof m.conductor === 'string' ? m.conductor : null,
        leadSinger: typeof m.leadSinger === 'string' ? m.leadSinger : null,
        drummer: typeof m.drummer === 'string' ? m.drummer : null,
        bassGuitarist: typeof m.bassGuitarist === 'string' ? m.bassGuitarist : null,
        leadKeyboardist: typeof m.leadKeyboardist === 'string' ? m.leadKeyboardist : null,
        customParts: m.customParts && typeof m.customParts === 'object' ? m.customParts : null,
        sourceType: typeof m.sourceType === 'string' ? m.sourceType : null,
        isHqOnly: !!m.isHqOnly || !!m.is_hq_only || m.status === 'hidden' || m.status === 'hq_only',
        isHistory: !!m.isHistory || !!m.is_history || m.status === 'history' || m.status === 'archived',
        status: typeof m.status === 'string' ? m.status : (m.isHistory || m.is_history ? 'history' : (m.isHqOnly || m.is_hq_only ? 'hidden' : 'active')),
        publishedAt: m.publishedAt || null,
        updatedAt: m.updatedAt || null,
      };
    });

    res.json({ success: true, count: songs.length, data: songs });
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
    res.json({ success: true, data: mergeRawRow(song) });
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
    const now = new Date();

    const row = await prisma.song.create({
      data: {
        id: songId,
        title: body.title || 'Untitled Master Song',
        key: body.key || null,
        tempo: body.tempo || null,
        lyrics: body.lyrics || null,
        writer: body.writer || null,
        category: body.category || 'Ministered Songs',
        audioFile: body.audioFile || body.audio_file || null,
        audioUrls: body.audioUrls || body.audio_urls || null,
        conductor: body.conductor || null,
        leadSinger: body.leadSinger || body.lead_singer || null,
        drummer: body.drummer || null,
        bassGuitarist: body.bassGuitarist || body.bass_guitarist || null,
        leadKeyboardist: body.leadKeyboardist || body.lead_keyboardist || null,
        categories: Array.isArray(body.categories) ? body.categories : (body.category ? [body.category] : []),
        isMinistered: true,
        organizationId: 'zone-001',
        rawData: { ...body, id: songId, createdAt: now.toISOString() },
      },
    });

    res.status(201).json({ success: true, message: 'Master song created', data: row });
  } catch (err) {
    console.error('[master POST]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// PATCH /master-songs/:id
router.patch('/:id', requireAuth, requireMasterEditor, async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Master song not found' });

    const prevRaw = (existing.rawData || {}) as Record<string, unknown>;
    const data: Record<string, any> = {
      updatedAt: new Date(),
      rawData: { ...prevRaw, ...body },
    };

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
    if (body.categories !== undefined) data.categories = body.categories;

    const updated = await prisma.song.update({ where: { id: songId }, data });
    res.json({ success: true, message: 'Master song updated', data: updated });
  } catch (err) {
    console.error('[master PATCH]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// DELETE /master-songs/:id
router.delete('/:id', requireAuth, requireMasterEditor, async (req: Request, res: Response) => {
  try {
    await prisma.song.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Master song deleted' });
  } catch (err) {
    console.error('[master DELETE]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

export default router;
