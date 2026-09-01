import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function formatSong(song: any) {
  const audio = song.audioFile || '';
  return {
    id: song.id,
    title: song.title || 'Untitled Song',
    key: song.key || null,
    tempo: song.tempo || null,
    lyrics: song.lyrics || '',
    solfas: song.solfas || '',
    solfa: song.solfas || '',
    writer: song.writer || '',
    leadSinger: song.leadSinger || 'Loveworld Singers',
    conductor: song.conductor || '',
    conductorGuide: song.conductor || '',
    drummer: song.drummer || '',
    leadKeyboardist: song.leadKeyboardist || '',
    leadGuitarist: song.leadGuitarist || '',
    bassGuitarist: song.bassGuitarist || '',
    audioFile: audio,
    audioUrl: audio,
    audioUrls: song.audioUrls || (audio ? { full: audio } : null),
    category: song.category || 'Praise Night',
    status: song.status || 'active',
    isMaster: Boolean(song.isMaster),
    isMinistered: Boolean(song.isMinistered),
    rehearsalCount: song.rehearsalCount || 0,
    organizationId: song.organizationId || null,
    groupId: song.groupId || null,
    createdAt: song.createdAt,
    updatedAt: song.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MASTER SONGS ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
const getMinisteredSongsHandler = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limitParam = req.query.limit ? parseInt(req.query.limit as string) : (req.query.page ? 50 : 1000);
    const limit = Math.min(2000, Math.max(1, isNaN(limitParam) ? 1000 : limitParam));
    const search = ((req.query.search as string) || '').trim();
    const skip = (page - 1) * limit;

    const where: any = { isMaster: true };

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { writer: { contains: search, mode: 'insensitive' } },
        { leadSinger: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.song.count({ where }),
      prisma.song.findMany({ where, orderBy: { title: 'asc' }, skip, take: limit }),
    ]);

    const formatted = rows.map(formatSong);
    res.json({
      success: true,
      count: formatted.length,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: formatted,
    });
  } catch (err) {
    console.error('[songs/master]', err);
    res.status(500).json({ success: false, error: 'Failed to load master songs' });
  }
};

router.get('/master', requireAuth, getMinisteredSongsHandler);
router.get('/ministered', requireAuth, getMinisteredSongsHandler);

const getMinisteredSongByIdHandler = async (req: Request, res: Response) => {
  try {
    const song = await prisma.song.findUnique({ where: { id: req.params.id } });
    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }
    res.json({ success: true, data: formatSong(song) });
  } catch (err) {
    console.error('[songs/master/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load song' });
  }
};

router.get('/master/:id', requireAuth, getMinisteredSongByIdHandler);
router.get('/ministered/:id', requireAuth, getMinisteredSongByIdHandler);

// ─────────────────────────────────────────────────────────────────────────────
// 2. MAIN REPERTOIRE & PROGRAM SONGS
// ─────────────────────────────────────────────────────────────────────────────
const getSongsHandler = async (req: Request, res: Response) => {
  try {
    const { praiseNightId, programId, zoneId, subGroupId, churchId, status } = req.query as Record<string, string>;
    const targetProgramId = programId || praiseNightId;
    const targetOrgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    let songs: any[] = [];

    if (targetProgramId) {
      // Find songs attached to this program via program_songs junction
      const program = await prisma.program.findUnique({
        where: { id: targetProgramId },
        include: {
          programSongs: {
            include: { song: true },
            orderBy: { order: 'asc' },
          },
        },
      });

      if (program) {
        songs = program.programSongs.map((ps) => ps.song);
      }
    } else {
      // Query songs for this organization or public master library
      const where: any = {
        OR: [
          { isMaster: true },
          { organizationId: targetOrgId },
        ],
      };

      if (status) {
        where.status = status;
      }

      songs = await prisma.song.findMany({
        where,
        orderBy: { title: 'asc' },
      });
    }

    const formatted = songs.map(formatSong);
    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    console.error('[songs:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load songs' });
  }
};

router.get('/', requireAuth, getSongsHandler);
router.get('/praise-night', requireAuth, getSongsHandler);

// ─────────────────────────────────────────────────────────────────────────────
// 3. SONG BY ID
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const song = await prisma.song.findUnique({
      where: { id: req.params.id },
      include: {
        programSongs: {
          include: { program: true },
        },
      },
    });

    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }

    res.json({ success: true, data: formatSong(song) });
  } catch (err) {
    console.error('[songs/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load song' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CREATE SONG
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const songId = body.id || `song_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const organizationId = body.zoneId || body.organizationId || req.tenant?.effectiveZoneId || 'zone-001';
    const programId = body.praiseNightId || body.programId || null;

    const newSong = await prisma.song.create({
      data: {
        id: songId,
        organizationId,
        groupId: body.groupId || body.subGroupId || body.churchId || null,
        title: body.title || 'Untitled Song',
        key: body.key || null,
        tempo: body.tempo || null,
        lyrics: body.lyrics || '',
        writer: body.writer || '',
        conductor: body.conductor || body.conductorGuide || '',
        leadSinger: body.leadSinger || body.lead_singer || '',
        drummer: body.drummer || '',
        leadKeyboardist: body.leadKeyboardist || body.lead_keyboardist || '',
        leadGuitarist: body.leadGuitarist || body.lead_guitarist || '',
        bassGuitarist: body.bassGuitarist || body.bass_guitarist || '',
        solfas: body.solfas || body.solfa || '',
        audioFile: body.audioFile || body.audio_file || body.audioUrl || null,
        audioUrls: body.audioUrls || body.audio_urls || null,
        category: body.category || 'Praise Night',
        status: body.status || 'active',
        isMaster: Boolean(body.isMaster),
        isMinistered: Boolean(body.isMinistered),
        ...(programId
          ? {
              programSongs: {
                create: {
                  programId,
                  order: body.order || 1,
                },
              },
            }
          : {}),
      },
    });

    broadcast('songs', newSong.id, formatSong(newSong));
    res.status(201).json({ success: true, message: 'Song created', data: formatSong(newSong) });
  } catch (err) {
    console.error('[songs:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create song' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. UPDATE SONG
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }

    const data: Record<string, any> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.writer !== undefined) data.writer = body.writer;
    if (body.conductor !== undefined || body.conductorGuide !== undefined) data.conductor = body.conductor || body.conductorGuide;
    if (body.leadSinger !== undefined || body.lead_singer !== undefined) data.leadSinger = body.leadSinger || body.lead_singer;
    if (body.drummer !== undefined) data.drummer = body.drummer;
    if (body.leadKeyboardist !== undefined || body.lead_keyboardist !== undefined) data.leadKeyboardist = body.leadKeyboardist || body.lead_keyboardist;
    if (body.leadGuitarist !== undefined || body.lead_guitarist !== undefined) data.leadGuitarist = body.leadGuitarist || body.lead_guitarist;
    if (body.bassGuitarist !== undefined || body.bass_guitarist !== undefined) data.bassGuitarist = body.bassGuitarist || body.bass_guitarist;
    if (body.solfas !== undefined || body.solfa !== undefined) data.solfas = body.solfas || body.solfa;
    if (body.audioFile !== undefined || body.audio_file !== undefined || body.audioUrl !== undefined) {
      data.audioFile = body.audioFile || body.audio_file || body.audioUrl;
    }
    if (body.audioUrls !== undefined || body.audio_urls !== undefined) data.audioUrls = body.audioUrls || body.audio_urls;
    if (body.category !== undefined) data.category = body.category;
    if (body.status !== undefined) data.status = body.status;
    if (body.isMaster !== undefined) data.isMaster = Boolean(body.isMaster);
    if (body.isMinistered !== undefined) data.isMinistered = Boolean(body.isMinistered);

    const updated = await prisma.song.update({
      where: { id: songId },
      data,
    });

    broadcast('songs', songId, formatSong(updated));
    res.json({ success: true, message: 'Song updated', data: formatSong(updated) });
  } catch (err) {
    console.error('[songs:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update song' });
  }
});

// PATCH /songs/:id/status & PATCH /songs/praise-night/:id/status
const updateSongStatusHandler = async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    const { status } = req.body;

    const updated = await prisma.song.update({
      where: { id: songId },
      data: { status: status || 'active' },
    });

    const formatted = formatSong(updated);
    broadcast('songs', songId, formatted);
    broadcast('song_status', songId, { id: songId, status: updated.status });
    res.json({ success: true, message: 'Song status updated', data: formatted });
  } catch (err) {
    console.error('[songs:status]', err);
    res.status(500).json({ success: false, error: 'Failed to update song status' });
  }
};

router.patch('/:id/status', requireAuth, updateSongStatusHandler);
router.patch('/praise-night/:id/status', requireAuth, updateSongStatusHandler);
router.patch('/praise-night/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Song not found' });

    const data: Record<string, any> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.writer !== undefined) data.writer = body.writer;
    if (body.status !== undefined) data.status = body.status;
    if (body.solfas !== undefined || body.solfa !== undefined) data.solfas = body.solfas || body.solfa;
    if (body.audioFile !== undefined || body.audioUrl !== undefined) data.audioFile = body.audioFile || body.audioUrl;

    const updated = await prisma.song.update({
      where: { id: songId },
      data,
    });

    const formatted = formatSong(updated);
    broadcast('songs', songId, formatted);
    res.json({ success: true, message: 'Song updated', data: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update song' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DELETE SONG
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    await prisma.song.delete({ where: { id: songId } });

    broadcast('songs', songId, { id: songId, deleted: true });
    res.json({ success: true, message: 'Song deleted' });
  } catch (err) {
    console.error('[songs:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete song' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. SONG HISTORY
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.query as { songId?: string };
    if (!songId) {
      res.status(400).json({ success: false, error: 'Missing songId' });
      return;
    }

    const history = await prisma.songHistory.findMany({
      where: { songId },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = history.map((h) => ({
      id: h.id,
      songId: h.songId,
      type: h.type || 'metadata',
      description: h.description || '',
      oldValue: h.oldValue || '',
      newValue: h.newValue || '',
      createdBy: h.user ? [h.user.firstName, h.user.lastName].filter(Boolean).join(' ') || h.user.email : 'Admin',
      createdAt: h.createdAt,
    }));

    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    console.error('[songs/history:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load song history' });
  }
});

router.post('/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const { songId, type, description, old_value, new_value } = body;

    if (!songId) {
      res.status(400).json({ success: false, error: 'Missing songId' });
      return;
    }

    const entry = await prisma.songHistory.create({
      data: {
        songId,
        userId: res.locals.auth?.userId || null,
        type: type || 'metadata',
        description: description || 'Song updated',
        oldValue: typeof old_value === 'object' ? JSON.stringify(old_value) : String(old_value || ''),
        newValue: typeof new_value === 'object' ? JSON.stringify(new_value) : String(new_value || ''),
      },
    });

    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    console.error('[songs/history:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to record song history' });
  }
});

router.delete('/history/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.songHistory.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'History entry deleted' });
  } catch (err) {
    console.error('[songs/history:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete history entry' });
  }
});

export default router;
