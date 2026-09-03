import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function resolveAudio(song: any): { audioUrl: string; audioUrls: Record<string, string> } {
  const urlsObj: Record<string, string> = {};
  if (song.audioUrls && typeof song.audioUrls === 'object') {
    Object.assign(urlsObj, song.audioUrls);
  }
  if (song.audio_urls && typeof song.audio_urls === 'object') {
    Object.assign(urlsObj, song.audio_urls);
  }
  if (song.sopranoUrl || song.soprano_url) urlsObj.soprano = song.sopranoUrl || song.soprano_url;
  if (song.altoUrl || song.alto_url) urlsObj.alto = song.altoUrl || song.alto_url;
  if (song.tenorUrl || song.tenor_url) urlsObj.tenor = song.tenorUrl || song.tenor_url;
  if (song.leadVocalUrl || song.lead_vocal_url) urlsObj.lead = song.leadVocalUrl || song.lead_vocal_url;
  if (song.instrumentalUrl || song.instrumental_url) urlsObj.instrumental = song.instrumentalUrl || song.instrumental_url;

  const audio =
    song.audioFile ||
    song.audio_file ||
    song.audioUrl ||
    song.audio_url ||
    song.url ||
    urlsObj.full ||
    urlsObj.main ||
    urlsObj.master ||
    urlsObj.lead ||
    urlsObj.soprano ||
    urlsObj.tenor ||
    urlsObj.alto ||
    (Object.values(urlsObj).find((v: any) => typeof v === 'string' && v.trim().length > 0) as string) ||
    '';

  if (audio && !urlsObj.full) {
    urlsObj.full = audio;
  }

  return { audioUrl: audio, audioUrls: urlsObj };
}

function formatSong(song: any) {
  return shapeSong(song);
}
function isConductorGuideText(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('harmony') ||
    lower.includes('harmonies') ||
    lower.includes('unison') ||
    lower.includes('verse 1') ||
    lower.includes('verse 2') ||
    lower.includes('modulate') ||
    lower.includes('modulation') ||
    lower.includes('coda') ||
    lower.includes('refrain') ||
    lower.includes('prechorus') ||
    lower.includes('pre-chorus') ||
    lower.includes('turnaround') ||
    lower.includes('interlude') ||
    (lower.includes('<div') && lower.includes('solo'))
  );
}

function shapeSong(song: any) {
  const audioUrls = (song.audioUrls as Record<string, string>) || {};
  const audioUrl = song.audioFile || audioUrls.full || null;

  // Extract primary program info from relation if populated
  const programSongs = song.programSongs || [];
  const primaryProgramSong = programSongs.length > 0 ? programSongs[0] : null;
  const primaryProgram = primaryProgramSong?.program || null;
  const programId = primaryProgram?.id || song.programId || null;
  const programName = primaryProgram?.name || song.program || null;

  const rawSolfas = song.solfas || '';
  const rawConductor = song.conductor || '';
  const rawConductorGuide = song.conductorGuide || '';

  const isGuideInSolfas = isConductorGuideText(rawSolfas);
  const resolvedConductorGuide = isGuideInSolfas ? rawSolfas : (rawConductorGuide || (isConductorGuideText(rawConductor) ? rawConductor : ''));
  const resolvedConductorPerson = isConductorGuideText(rawConductor) ? '' : rawConductor;
  const resolvedSolfa = isGuideInSolfas ? '' : rawSolfas;

  const historySummary = programName
    ? `**Ministered at ${programName}**\n\n- **Lead Singer:** ${song.leadSinger || 'Loveworld Singers'}\n- **Conductor:** ${resolvedConductorPerson || '—'}\n- **Key:** ${song.key || '—'} · **Tempo:** ${song.tempo || '—'}\n- **Rehearsal Count:** x${song.rehearsalCount || 0}`
    : (song.createdAt ? `**Catalog Entry**\n\n- **Lead Singer:** ${song.leadSinger || 'Loveworld Singers'}\n- **Key:** ${song.key || '—'}` : '');

  return {
    id: song.id,
    praiseNightId: programId,
    programId: programId,
    program: programName,
    programName: programName,
    programBannerImage: primaryProgram?.bannerImage || null,
    order: song.order !== undefined ? song.order : (primaryProgramSong?.order ?? null),
    title: song.title || 'Untitled Song',
    key: song.key || null,
    tempo: song.tempo || null,
    lyrics: song.lyrics || '',
    karaokeLrcText: song.lyrics || '',
    lrcText: song.lyrics || '',
    syncedLyricsText: song.lyrics || '',
    solfas: resolvedSolfa,
    solfa: resolvedSolfa,
    writer: song.writer || '',
    leadSinger: song.leadSinger || 'Loveworld Singers',
    conductor: resolvedConductorPerson,
    conductorGuide: resolvedConductorGuide,
    drummer: song.drummer || '',
    leadKeyboardist: song.leadKeyboardist || '',
    leadGuitarist: song.leadGuitarist || '',
    bassGuitarist: song.bassGuitarist || '',
    audioFile: audioUrl,
    audioUrl: audioUrl,
    audioUrls: Object.keys(audioUrls).length > 0 ? audioUrls : (audioUrl ? { full: audioUrl } : null),
    category: song.category || 'Praise Night',
    status: song.status || 'active',
    isMaster: Boolean(song.isMaster),
    isMinistered: Boolean(song.isMinistered),
    rehearsalCount: song.rehearsalCount || 0,
    organizationId: song.organizationId || null,
    groupId: song.groupId || null,
    history: historySummary,
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
      prisma.song.findMany({
        where,
        include: {
          programSongs: {
            include: {
              program: {
                select: { id: true, name: true, bannerImage: true }
              }
            },
            take: 1
          }
        },
        orderBy: { title: 'asc' },
        skip,
        take: limit
      }),
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
    const song = await prisma.song.findUnique({
      where: { id: req.params.id },
    });
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

router.post('/import-from-ministered', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songIds = [] } = req.body || {};
    const orgId = req.tenant?.effectiveZoneId || 'zone-001';

    if (!Array.isArray(songIds) || songIds.length === 0) {
      return res.status(400).json({ success: false, error: 'songIds array is required' });
    }

    const songs = await prisma.song.findMany({
      where: { id: { in: songIds } },
    });

    for (const song of songs) {
      await prisma.song.update({
        where: { id: song.id },
        data: {
          organizationId: orgId,
          status: 'active',
        },
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: `${songs.length} song(s) imported to repertoire.`,
      importedCount: songs.length,
    });
  } catch (err) {
    console.error('[songs/import-from-ministered]', err);
    res.status(500).json({ success: false, error: 'Failed to import songs' });
  }
});

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

      if (program && Array.isArray(program.programSongs)) {
        songs = program.programSongs.map((ps) => ({
          ...ps.song,
          order: ps.order,
          praiseNightId: targetProgramId,
          programId: targetProgramId,
        }));
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
router.get('/zone', requireAuth, getSongsHandler);
router.get('/zone-songs', requireAuth, getSongsHandler);

// ─────────────────────────────────────────────────────────────────────────────
// 3. SONG HISTORY (Must be BEFORE /:id so Express does not capture /history as an ID!)
// ─────────────────────────────────────────────────────────────────────────────
const getSongHistoryHandler = async (req: Request, res: Response) => {
  try {
    const songId = (req.params.id || req.query.songId || '') as string;
    if (!songId) {
      res.status(400).json({ success: false, error: 'Missing songId' });
      return;
    }

    const song = await prisma.song.findUnique({
      where: { id: songId },
      include: {
        programSongs: {
          include: { program: true },
          orderBy: { program: { createdAt: 'desc' } },
        },
      },
    });

    const history = await prisma.songHistory.findMany({
      where: { songId },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const formatted: any[] = history.map((h) => ({
      id: h.id,
      songId: h.songId,
      type: h.type || 'metadata',
      title: h.description || 'Song Update',
      description: h.description || '',
      old_value: h.oldValue || '',
      new_value: h.newValue || '',
      oldValue: h.oldValue || '',
      newValue: h.newValue || '',
      createdBy: h.user ? [h.user.firstName, h.user.lastName].filter(Boolean).join(' ') || h.user.email : 'Admin',
      createdAt: h.createdAt,
      created_at: h.createdAt,
    }));

    if (song) {
      if (song.programSongs && song.programSongs.length > 0) {
        for (const ps of song.programSongs) {
          const progName = ps.program?.name || 'Program Repertoire';
          const progDate = ps.program?.date || (ps.program?.createdAt ? new Date(ps.program.createdAt).toISOString() : song.createdAt);
          formatted.push({
            id: `prog-${ps.id}`,
            songId,
            type: 'details',
            title: `Ministered at ${progName}`,
            description: `Program Edition: ${progName} • Lead Singer: ${song.leadSinger || 'Loveworld Singers'}${song.conductor ? ` • Conductor: ${song.conductor}` : ''}`,
            new_value: JSON.stringify({
              program: progName,
              leadSinger: song.leadSinger || 'Loveworld Singers',
              conductor: song.conductor || '—',
              key: song.key || '—',
              tempo: song.tempo || '—',
              rehearsalCount: song.rehearsalCount || 0,
              date: ps.program?.date || '—',
            }),
            old_value: '',
            createdBy: 'Ministry Archive',
            createdAt: progDate,
            created_at: progDate,
          });
        }
      }

      const audioUrl = song.audioFile || (song.audioUrls as any)?.full || null;
      if (audioUrl) {
        formatted.push({
          id: `audio-baseline-${song.id}`,
          songId,
          type: 'audio',
          title: `Master Audio Track`,
          description: `Original master audio recorded for ${song.title}`,
          audioUrl: audioUrl,
          new_value: audioUrl,
          old_value: '',
          createdBy: 'Master Library',
          createdAt: song.createdAt,
          created_at: song.createdAt,
        });
      }

      if (song.lyrics) {
        formatted.push({
          id: `lyrics-baseline-${song.id}`,
          songId,
          type: 'lyrics',
          title: `Master Lyrics (${song.title})`,
          description: `Archived ministry lyrics`,
          new_value: song.lyrics,
          old_value: '',
          createdBy: song.writer ? `Written by ${song.writer}` : 'Ministry Archive',
          createdAt: song.createdAt,
          created_at: song.createdAt,
        });
      }

      const guideText = isConductorGuideText(song.solfas) ? song.solfas : '';
      if (guideText) {
        formatted.push({
          id: `conductor-baseline-${song.id}`,
          songId,
          type: 'conductor',
          title: `Conductor Arrangement Guide`,
          description: song.conductor ? `Arrangement cues for ${song.conductor}` : 'Arrangement cues',
          new_value: guideText,
          old_value: '',
          createdBy: song.conductor ? `Conductor ${song.conductor}` : 'Director Archive',
          createdAt: song.createdAt,
          created_at: song.createdAt,
        });
      }
    }

    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    console.error('[songs/history:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load song history' });
  }
};

router.get('/history', requireAuth, getSongHistoryHandler);
router.get('/:id/history', requireAuth, getSongHistoryHandler);

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

// ─────────────────────────────────────────────────────────────────────────────
// 4. SONG BY ID
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
// 8. PERSONAL NOTES & DOODLE ANNOTATIONS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/notes/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.params;
    const userId = res.locals.auth?.userId || 'guest';
    const key = `song_note_${userId}_${songId}`;

    const setting = await prisma.setting.findUnique({ where: { key } });
    const notes = setting?.value && typeof setting.value === 'object' ? (setting.value as any).notes || '' : '';

    res.json({ success: true, data: { notes, note: notes } });
  } catch (err) {
    console.error('[songs/notes:GET]', err);
    res.json({ success: true, data: { notes: '', note: '' } });
  }
});

router.patch('/notes/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.params;
    const userId = res.locals.auth?.userId || 'guest';
    const key = `song_note_${userId}_${songId}`;
    const notes = req.body.notes || req.body.note || '';

    await prisma.setting.upsert({
      where: { key },
      update: { value: { notes, updatedAt: new Date().toISOString() } },
      create: { key, value: { notes, updatedAt: new Date().toISOString() } },
    });

    res.json({ success: true, message: 'Notes saved', data: { notes } });
  } catch (err) {
    console.error('[songs/notes:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to save notes' });
  }
});

router.get('/annotations/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.params;
    const key = `song_anno_${songId}`;

    const setting = await prisma.setting.findUnique({ where: { key } });
    const strokes = setting?.value && typeof setting.value === 'object' ? (setting.value as any).strokes || [] : [];

    res.json({ success: true, data: { strokes } });
  } catch (err) {
    console.error('[songs/annotations:GET]', err);
    res.json({ success: true, data: { strokes: [] } });
  }
});

router.patch('/annotations/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.params;
    const key = `song_anno_${songId}`;
    const strokes = req.body.data?.strokes || req.body.strokes || [];

    await prisma.setting.upsert({
      where: { key },
      update: { value: { strokes, updatedAt: new Date().toISOString() } },
      create: { key, value: { strokes, updatedAt: new Date().toISOString() } },
    });

    broadcast('annotation', songId, { songId, strokes });
    res.json({ success: true, message: 'Annotations saved', data: { strokes } });
  } catch (err) {
    console.error('[songs/annotations:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to save annotations' });
  }
});

export default router;
