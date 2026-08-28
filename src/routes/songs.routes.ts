import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';
import { broadcast } from '../ws/wsServer';

const router = Router();

// GET /songs/master & /songs/ministered — ministered songs library
const getMinisteredSongsHandler = async (_req: any, res: any) => {
  try {
    const rows = await prisma.song.findMany({
      where: {
        OR: [
          { isMinistered: true },
          { category: 'Ministered Songs' },
          { scope: 'hq' },
        ],
      },
      orderBy: { title: 'asc' },
    });
    const merged = rows.map((r) => {
      const m = mergeRawRow(r);
      const raw = (r.rawData && typeof r.rawData === 'object') ? (r.rawData as Record<string, any>) : {};
      const audioFile = r.audioFile || raw.audioFile || raw.audioUrl || (m.audioFile as string) || '';
      return {
        ...m,
        id: r.id,
        title: r.title || raw.title || 'Untitled Song',
        audioFile,
        audioUrl: audioFile,
        audioUrls: r.audioUrls || raw.audioUrls || m.audioUrls || { full: audioFile },
        lyrics: r.lyrics || raw.lyrics || m.lyrics || '',
        solfa: r.solfas || raw.solfas || raw.solfa || m.solfa || '',
        leadSinger: (r as any).leadSinger || raw.leadSinger || raw.lead_singer || m.leadSinger || 'Loveworld Singers',
        writer: (r as any).writer || raw.writer || m.writer || '',
        category: r.category || raw.category || m.category || 'Praise Night',
        key: r.key || raw.key || m.key || '',
        tempo: r.tempo || raw.tempo || m.tempo || '',
        conductorGuide: raw.conductorGuide || raw.conductor_guide || '',
      };
    });
    res.json({ success: true, count: merged.length, data: merged });
  } catch (err) {
    console.error('[songs/ministered]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};
router.get('/master', requireAuth, getMinisteredSongsHandler);
router.get('/ministered', requireAuth, getMinisteredSongsHandler);

const getMinisteredSongByIdHandler = async (req: any, res: any) => {
  try {
    const song = await prisma.song.findUnique({ where: { id: req.params.id } });
    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }
    const m = mergeRawRow(song);
    const raw = (song.rawData && typeof song.rawData === 'object') ? (song.rawData as Record<string, any>) : {};
    const audioFile = song.audioFile || raw.audioFile || raw.audioUrl || (m.audioFile as string) || '';
    res.json({
      success: true,
      data: {
        ...m,
        id: song.id,
        title: song.title || raw.title || 'Untitled Song',
        audioFile,
        audioUrl: audioFile,
        audioUrls: song.audioUrls || raw.audioUrls || m.audioUrls || { full: audioFile },
        lyrics: song.lyrics || raw.lyrics || m.lyrics || '',
        solfa: song.solfas || raw.solfas || raw.solfa || m.solfa || '',
        leadSinger: (song as any).leadSinger || raw.leadSinger || raw.lead_singer || m.leadSinger || 'Loveworld Singers',
        writer: (song as any).writer || raw.writer || m.writer || '',
        category: song.category || raw.category || m.category || 'Praise Night',
        key: song.key || raw.key || m.key || '',
        tempo: song.tempo || raw.tempo || m.tempo || '',
        conductorGuide: raw.conductorGuide || raw.conductor_guide || '',
      },
    });
  } catch (err) {
    console.error('[songs/ministered/:id]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};
router.get('/master/:id', requireAuth, getMinisteredSongByIdHandler);
router.get('/ministered/:id', requireAuth, getMinisteredSongByIdHandler);

// GET /songs/praise-night & GET /songs — Main Repertoire
const getSongsHandler = async (req: any, res: any) => {
  try {
    const { praiseNightId, programId, zoneId, subGroupId, churchId } = req.query;
    const targetProgramId = (programId || praiseNightId) as string | undefined;
    const targetChurchId = (subGroupId || churchId) as string | undefined;

    let rows: any[] = [];
    if (targetProgramId) {
      const mainRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM songs
         WHERE praise_night_id = $1
            OR raw_data->>'praiseNightId' = $1
            OR raw_data->>'programId' = $1
            OR lower(raw_data->>'praise_night_id') = $2
         ORDER BY title ASC`,
        targetProgramId,
        targetProgramId.toLowerCase(),
      );
      rows = mainRows;

      // Fallback: check if the program itself has embedded songs
      if (rows.length === 0) {
        const p = await prisma.program.findUnique({ where: { id: targetProgramId } });
        if (p) {
          const raw = mergeRawRow(p);
          if (Array.isArray(raw.songs) && raw.songs.length > 0) {
            rows = raw.songs;
          }
        }
      }
    } else if (targetChurchId) {
      const churchSongs = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM songs
         WHERE subgroup_id = $1
            OR raw_data->>'subGroupId' = $1
            OR raw_data->>'churchId' = $1
         ORDER BY title ASC`,
        targetChurchId,
      );
      rows = churchSongs;
    } else if (zoneId && zoneId !== 'all' && zoneId !== 'global') {
      const cleanZone = (zoneId as string).toLowerCase().trim();
      const withoutHyphen = cleanZone.replace(/[\s-_]/g, '');
      const withHyphen = cleanZone.includes('-') ? cleanZone : cleanZone.replace(/^zone(\d+)$/, 'zone-$1');

      // Find programs belonging to this zone to extract embedded songs
      const progs = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM programs
         WHERE lower(replace(replace(COALESCE(zone_id, ''), '-', ''), ' ', '')) = $1
            OR lower(COALESCE(zone_id, '')) = $2
            OR lower(COALESCE(zone_id, '')) = $3
            OR lower(replace(replace(COALESCE(raw_data->>'zone_code', ''), '-', ''), ' ', '')) = $1
            OR lower(replace(replace(COALESCE(raw_data->>'zoneId', ''), '-', ''), ' ', '')) = $1`,
        withoutHyphen,
        cleanZone,
        withHyphen,
      );

      const embeddedSongs: any[] = [];
      progs.forEach((p: any) => {
        const merged = mergeRawRow(p);
        if (Array.isArray(merged.songs)) {
          merged.songs.forEach((s: any) => embeddedSongs.push(s));
        }
      });

      const mainRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM songs
         WHERE scope = 'hq'
            OR lower(replace(replace(COALESCE(zone_id, ''), '-', ''), ' ', '')) = $1
            OR lower(COALESCE(zone_id, '')) = $2
            OR lower(COALESCE(zone_id, '')) = $3
            OR lower(replace(replace(COALESCE(raw_data->>'zone_code', ''), '-', ''), ' ', '')) = $1
            OR lower(replace(replace(COALESCE(raw_data->>'zoneId', ''), '-', ''), ' ', '')) = $1
            OR lower(replace(replace(COALESCE(raw_data->>'zone_id', ''), '-', ''), ' ', '')) = $1`,
        withoutHyphen,
        cleanZone,
        withHyphen,
      );

      const allMerged = [...mainRows, ...embeddedSongs];
      const seen = new Set<string>();
      rows = allMerged.filter((s: any) => {
        const key = String(s.id || s.title || '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) =>
        String(a.title || '').localeCompare(String(b.title || ''))
      );
    } else {
      rows = await prisma.song.findMany({ orderBy: { title: 'asc' } });
    }

    res.json({ success: true, count: rows.length, data: rows.map(mergeRawRow) });
  } catch (err) {
    console.error('[songs/praise-night]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};
router.get('/praise-night', requireAuth, getSongsHandler);
router.get('/program', requireAuth, getSongsHandler);

const getSongByIdHandler = async (req: any, res: any) => {
  try {
    const song = await prisma.song.findUnique({ where: { id: req.params.id } });
    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }
    res.json({ success: true, data: mergeRawRow(song) });
  } catch (err) {
    console.error('[songs/praise-night/:id]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};
router.get('/praise-night/:id', requireAuth, getSongByIdHandler);

/** GET /songs/zone — list zone songs */
router.get('/zone', requireAuth, async (req, res) => {
  try {
    const { zoneId } = req.query;
    const songs = await prisma.song.findMany({
      where: zoneId ? { zoneId: zoneId as string } : undefined,
    });
    res.json({ success: true, count: songs.length, data: songs.map(mergeRawRow) });
  } catch (err) {
    console.error('[songs/zone]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /songs/zone/:id — existing Supabase zone_songs */
router.get('/zone/:id', requireAuth, async (req, res) => {
  try {
    const song = await prisma.song.findUnique({ where: { id: req.params.id } });
    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }
    res.json({ success: true, data: mergeRawRow(song) });
  } catch (err) {
    console.error('[songs/zone/:id]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /songs/subgroup — list subgroup songs */
router.get('/subgroup', requireAuth, async (req, res) => {
  try {
    const { subGroupId, zoneId } = req.query;
    let songs: any[];
    if (subGroupId) {
      songs = await prisma.song.findMany({
        where: {
          OR: [
            { subgroupId: subGroupId as string },
            { rawData: { path: ['subGroupId'], equals: subGroupId as string } },
            { rawData: { path: ['sub_group_id'], equals: subGroupId as string } },
          ],
        },
      });
    } else if (zoneId) {
      songs = await prisma.song.findMany({ where: { zoneId: zoneId as string } });
    } else {
      songs = await prisma.song.findMany();
    }
    res.json({ success: true, count: songs.length, data: songs.map(mergeRawRow) });
  } catch (err) {
    console.error('[songs/subgroup]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /songs/subgroup/:id — existing Supabase subgroup_songs */
router.get('/subgroup/:id', requireAuth, async (req, res) => {
  try {
    const song = await prisma.song.findUnique({ where: { id: req.params.id } });
    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }
    res.json({ success: true, data: mergeRawRow(song) });
  } catch (err) {
    console.error('[songs/subgroup/:id]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /songs/zone-praise-nights — list */
router.get('/zone-praise-nights', requireAuth, async (req, res) => {
  try {
    const { zoneId } = req.query;
    let rows: any[];
    if (zoneId) {
      rows = await prisma.program.findMany({
        where: {
          OR: [
            { zoneId: zoneId as string },
            { rawData: { path: ['zoneId'], equals: zoneId as string } },
            { rawData: { path: ['zone_id'], equals: zoneId as string } },
          ],
        },
      });
    } else {
      rows = await prisma.program.findMany();
    }
    res.json({ success: true, count: rows.length, data: rows.map(mergeRawRow) });
  } catch (err) {
    console.error('[songs/zone-praise-nights]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /songs/zone-praise-nights/:id */
router.get('/zone-praise-nights/:id', requireAuth, async (req, res) => {
  try {
    const row = await prisma.program.findUnique({ where: { id: req.params.id } });
    if (!row) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({ success: true, data: mergeRawRow(row) });
  } catch (err) {
    console.error('[songs/zone-praise-nights/:id]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /songs/subgroup-praise-nights — list */
router.get('/subgroup-praise-nights', requireAuth, async (req, res) => {
  try {
    const { subGroupId } = req.query;
    const rows = await prisma.program.findMany({
      where: subGroupId ? {
        OR: [
          { subgroupId: subGroupId as string },
          { rawData: { path: ['subGroupId'], equals: subGroupId as string } },
          { rawData: { path: ['sub_group_id'], equals: subGroupId as string } },
        ]
      } : undefined,
    });
    res.json({ success: true, count: rows.length, data: rows.map(mergeRawRow) });
  } catch (err) {
    console.error('[songs/subgroup-praise-nights]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /songs/subgroup-praise-nights/:id */
router.get('/subgroup-praise-nights/:id', requireAuth, async (req, res) => {
  try {
    const row = await prisma.program.findUnique({ where: { id: req.params.id } });
    if (!row) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({ success: true, data: mergeRawRow(row) });
  } catch (err) {
    console.error('[songs/subgroup-praise-nights/:id]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** GET /songs/notes/:songId — load the authenticated user's personal note for a song */
router.get('/notes/:songId', requireAuth, async (req: any, res: any) => {
  try {
    const { songId } = req.params;
    const userId = res.locals.auth?.userId;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const noteId = `note_${userId}_${songId}`;
    const own = await prisma.userSongNote.findUnique({ where: { id: noteId } });
    if (own) {
      const raw = (own.rawData && typeof own.rawData === 'object') ? own.rawData as Record<string, any> : {};
      res.json({ success: true, data: { notes: raw.notes || '', id: own.id } });
    } else {
      res.json({ success: true, data: null });
    }
  } catch (err) {
    console.error('[songs/notes/:songId:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load notes' });
  }
});

/** GET /songs/annotations/:songId — load all annotations (doodles) for a song */
router.get('/annotations/:songId', requireAuth, async (req: any, res: any) => {
  try {
    const { songId } = req.params;
    const rows = await prisma.mediaDoodle.findMany({ where: { songId } });
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    console.error('[songs/annotations/:songId:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load annotations' });
  }
});

/** GET /songs/history */
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { songId, title } = req.query as { songId?: string; title?: string };
    if (!songId && !title) {
      res.status(400).json({ success: false, error: 'Missing songId or title' });
      return;
    }

    const sid = typeof songId === 'string' ? songId.trim() : '';
    const stitle = typeof title === 'string' ? title.trim() : '';

    let rows: any[] = [];
    if (sid && stitle) {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM song_history
         WHERE song_id = $1 OR raw_data->>'songId' = $1 OR raw_data->>'song_id' = $1 OR raw_data->>'firebaseId' = $1
            OR lower(title) = lower($2) OR lower(raw_data->>'title') = lower($2) OR lower(raw_data->>'songTitle') = lower($2)
         ORDER BY created_at DESC`,
        sid,
        stitle,
      );
    } else if (sid) {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM song_history
         WHERE song_id = $1 OR raw_data->>'songId' = $1 OR raw_data->>'song_id' = $1 OR raw_data->>'firebaseId' = $1
         ORDER BY created_at DESC`,
        sid,
      );
    } else if (stitle) {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM song_history
         WHERE lower(title) = lower($1) OR lower(raw_data->>'title') = lower($1) OR lower(raw_data->>'songTitle') = lower($1)
         ORDER BY created_at DESC`,
        stitle,
      );
    }

    const merged = rows.map(mergeRawRow);

    if (merged.length === 0 && sid) {
      const foundSong = await prisma.song.findUnique({ where: { id: sid } });

      if (foundSong) {
        let history = (foundSong as any).rawData?.history || (foundSong as any).raw_data?.history;
        if (typeof history === 'string') {
          try {
            history = JSON.parse(history);
          } catch {
            history = [];
          }
        }
        if (Array.isArray(history) && history.length > 0) {
          res.json({ success: true, count: history.length, data: history });
          return;
        }
      }
    }

    res.json({ success: true, count: merged.length, data: merged });
  } catch (err) {
    console.error('[songs/history]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** POST /songs/history */
router.post('/history', requireAuth, async (req: any, res: any) => {
  try {
    const body = req.body || {};
    const { songId, type, title, new_value, old_value, description } = body;
    if (!songId) {
      res.status(400).json({ success: false, error: 'Missing songId' });
      return;
    }

    const id = body.id || `hist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const createdBy = body.created_by || req.user?.displayName || req.user?.email || 'Admin';
    const now = new Date();

    const row = {
      id,
      songId,
      type: type || 'metadata',
      title: title || 'Song Update',
      newValue: typeof new_value === 'object' ? JSON.stringify(new_value) : String(new_value || ''),
      oldValue: typeof old_value === 'object' ? JSON.stringify(old_value) : String(old_value || ''),
      description: description || 'Song changes updated',
      createdBy,
      createdAt: now,
      rawData: {
        ...body,
        id,
        songId,
        type,
        title,
        new_value,
        old_value,
        description,
        created_by: createdBy,
        created_at: now.toISOString(),
      },
    };

    await prisma.songHistory.create({ data: row });
    res.json({ success: true, data: mergeRawRow(row) });
  } catch (err) {
    console.error('[songs/history POST]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

/** DELETE /songs/history/:id */
router.delete('/history/:id', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ success: false, error: 'Missing history id' });
      return;
    }
    await prisma.songHistory.delete({ where: { id } });
    res.json({ success: true, message: 'History entry deleted' });
  } catch (err) {
    console.error('[songs/history DELETE]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// Helper for song creation
const createSongHandler = async (req: any, res: any) => {
  try {
    const auth = res.locals.auth;
    const body = req.body || {};
    const songId = body.id || `song_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const zoneId = body.zoneId || auth.effectiveZoneId || auth.zoneId || null;
    const praiseNightId = body.praiseNightId || body.programId || null;

    const songRow: any = {
      id: songId,
      title: body.title || 'Untitled Song',
      key: body.key || null,
      tempo: body.tempo || null,
      lyrics: body.lyrics || null,
      writer: body.writer || null,
      category: body.category || null,
      audioFile: body.audioFile || body.audio_file || null,
      audioUrls: body.audioUrls || body.audio_urls || null,
      conductor: body.conductor || null,
      leadSinger: body.leadSinger || body.lead_singer || null,
      drummer: body.drummer || null,
      zoneId: zoneId || null,
      praiseNightId: praiseNightId || null,
      status: body.status || 'unheard',
      isActive: Boolean(body.isActive),
      categories: body.categories || (body.category ? [body.category] : []),
      createdAt: new Date().toISOString(),
      updatedAt: new Date(),
      rawData: { ...body, id: songId, zoneId, praiseNightId },
    };

    await prisma.song.upsert({
      where: { id: songId },
      update: songRow,
      create: songRow,
    });

    const mergedCreated = mergeRawRow(songRow);
    broadcast('song', songId, mergedCreated);
    broadcast('song', 'all', mergedCreated);
    if (praiseNightId) {
      broadcast('songs', praiseNightId, mergedCreated);
    }

    res.status(201).json({ success: true, message: 'Song created successfully', data: songRow });
  } catch (err) {
    console.error('[songs/create]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};

router.post('/', requireAuth, requireTenantAdmin, createSongHandler);
router.post('/praise-night', requireAuth, requireTenantAdmin, createSongHandler);

// Helper for song update
const updateSongHandler = async (req: any, res: any) => {
  try {
    const songId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });

    if (!existing) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }

    const prevRaw = (existing?.rawData || {}) as Record<string, unknown>;
    const updatedRaw = { ...prevRaw, ...body };

    const updateFields: Record<string, any> = {
      updatedAt: new Date(),
      rawData: updatedRaw,
    };

    if (body.title !== undefined) updateFields.title = body.title;
    if (body.key !== undefined) updateFields.key = body.key;
    if (body.tempo !== undefined) updateFields.tempo = body.tempo;
    if (body.lyrics !== undefined) updateFields.lyrics = body.lyrics;
    if (body.writer !== undefined) updateFields.writer = body.writer;
    if (body.category !== undefined) updateFields.category = body.category;
    if (body.audioFile !== undefined || body.audio_file !== undefined) updateFields.audioFile = body.audioFile || body.audio_file;
    if (body.audioUrls !== undefined || body.audio_urls !== undefined) updateFields.audioUrls = body.audioUrls || body.audio_urls;
    if (body.conductor !== undefined) updateFields.conductor = body.conductor;
    if (body.leadSinger !== undefined || body.lead_singer !== undefined) updateFields.leadSinger = body.leadSinger || body.lead_singer;
    if (body.drummer !== undefined) updateFields.drummer = body.drummer;
    if (body.status !== undefined) updateFields.status = body.status;
    if (body.isActive !== undefined) updateFields.isActive = Boolean(body.isActive);
    if (body.categories !== undefined) updateFields.categories = body.categories;
    if (body.praiseNightId !== undefined) updateFields.praiseNightId = body.praiseNightId;
    if (body.zoneId !== undefined) updateFields.zoneId = body.zoneId;

    await prisma.song.update({ where: { id: songId }, data: updateFields });

    const mergedSong = mergeRawRow({ ...existing, ...updateFields, rawData: updatedRaw } as any);
    broadcast('song', songId, mergedSong);
    broadcast('song', 'all', mergedSong);
    const pId = updateFields.praiseNightId || existing?.praiseNightId;
    if (pId) {
      broadcast('songs', String(pId), mergedSong);
    }

    res.json({ success: true, message: 'Song updated successfully', data: { id: songId, ...updateFields, ...mergedSong } });
  } catch (err) {
    console.error('[songs/update]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};

router.patch('/:id', requireAuth, requireTenantAdmin, updateSongHandler);
router.patch('/praise-night/:id', requireAuth, requireTenantAdmin, updateSongHandler);

// Toggle song status (heard / unheard)
const toggleStatusHandler = async (req: any, res: any) => {
  try {
    const songId = req.params.id;
    const { status } = req.body;

    if (!status) {
      res.status(400).json({ success: false, error: 'Missing status parameter' });
      return;
    }

    await prisma.song.update({ where: { id: songId }, data: { status, updatedAt: new Date() } });

    broadcast('song', songId, { id: songId, status });
    broadcast('song', 'all', { id: songId, status });

    res.json({ success: true, message: `Song status updated to ${status}` });
  } catch (err) {
    console.error('[songs/:id/status]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};

router.patch('/:id/status', requireAuth, requireTenantAdmin, toggleStatusHandler);
router.patch('/praise-night/:id/status', requireAuth, requireTenantAdmin, toggleStatusHandler);

// Toggle song active status
const toggleActiveHandler = async (req: any, res: any) => {
  try {
    const songId = req.params.id;
    const { isActive, praiseNightId } = req.body;

    if (isActive && praiseNightId) {
      await prisma.song.updateMany({
        where: { praiseNightId },
        data: { isActive: false, updatedAt: new Date() },
      });
    }

    await prisma.song.update({
      where: { id: songId },
      data: { isActive: Boolean(isActive), updatedAt: new Date() },
    });

    broadcast('song', songId, { id: songId, isActive: Boolean(isActive) });
    broadcast('song', 'all', { id: songId, isActive: Boolean(isActive) });

    res.json({ success: true, message: `Song active state set to ${Boolean(isActive)}` });
  } catch (err) {
    console.error('[songs/:id/active]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};

router.patch('/:id/active', requireAuth, requireTenantAdmin, toggleActiveHandler);
router.patch('/praise-night/:id/active', requireAuth, requireTenantAdmin, toggleActiveHandler);

// Delete song
const deleteSongHandler = async (req: any, res: any) => {
  try {
    const songId = req.params.id;

    await prisma.song.deleteMany({ where: { id: songId } });

    broadcast('song', songId, { id: songId, deleted: true });
    broadcast('song', 'all', { id: songId, deleted: true });

    res.json({ success: true, message: 'Song deleted successfully' });
  } catch (err) {
    console.error('[songs/delete]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
};

router.delete('/:id', requireAuth, requireTenantAdmin, deleteSongHandler);
router.delete('/praise-night/:id', requireAuth, requireTenantAdmin, deleteSongHandler);

// Master / Ministered Songs Write routes
router.post('/master', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const songId = body.id || `ms_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const row = {
      id: songId,
      title: body.title || 'Untitled Song',
      key: body.key || null,
      tempo: body.tempo || null,
      lyrics: body.lyrics || null,
      writer: body.writer || null,
      solfa: body.solfa || body.solfas || null,
      category: body.category || null,
      imageUrl: body.imageUrl || body.image_url || null,
      audioFile: body.audioFile || body.audio_file || null,
      audioUrls: body.audioUrls || body.audio_urls || null,
      conductor: body.conductor || null,
      leadSinger: body.leadSinger || body.lead_singer || null,
      drummer: body.drummer || null,
      bassGuitarist: body.bassGuitarist || body.bass_guitarist || null,
      leadKeyboardist: body.leadKeyboardist || body.lead_keyboardist || null,
      categories: body.categories || [],
      customParts: body.customParts || body.custom_parts || [],
      publishedAt: new Date(),
      updatedAt: new Date(),
      sourceType: body.sourceType || 'manual',
      isHqOnly: Boolean(body.isHqOnly),
      isMinistered: true,
      scope: 'hq',
      rawData: { ...body, id: songId },
    };

    await prisma.song.create({ data: row });
    res.status(201).json({ success: true, message: 'Master song created', data: row });
  } catch (err) {
    console.error('[songs/master POST]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.patch('/master/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const songId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Master song not found' });
      return;
    }

    const prevRaw = (existing.rawData || {}) as Record<string, unknown>;
    const updateFields: Record<string, any> = {
      updatedAt: new Date(),
      rawData: { ...prevRaw, ...body },
    };

    if (body.title !== undefined) updateFields.title = body.title;
    if (body.key !== undefined) updateFields.key = body.key;
    if (body.tempo !== undefined) updateFields.tempo = body.tempo;
    if (body.lyrics !== undefined) updateFields.lyrics = body.lyrics;
    if (body.writer !== undefined) updateFields.writer = body.writer;
    if (body.category !== undefined) updateFields.category = body.category;
    if (body.audioFile !== undefined || body.audio_file !== undefined) updateFields.audioFile = body.audioFile || body.audio_file;
    if (body.audioUrls !== undefined || body.audio_urls !== undefined) updateFields.audioUrls = body.audioUrls || body.audio_urls;
    if (body.conductor !== undefined) updateFields.conductor = body.conductor;
    if (body.leadSinger !== undefined || body.lead_singer !== undefined) updateFields.leadSinger = body.leadSinger || body.lead_singer;
    if (body.drummer !== undefined) updateFields.drummer = body.drummer;
    if (body.bassGuitarist !== undefined || body.bass_guitarist !== undefined) updateFields.bassGuitarist = body.bassGuitarist || body.bass_guitarist;
    if (body.leadKeyboardist !== undefined || body.lead_keyboardist !== undefined) updateFields.leadKeyboardist = body.leadKeyboardist || body.lead_keyboardist;
    if (body.categories !== undefined) updateFields.categories = body.categories;

    await prisma.song.update({ where: { id: songId }, data: updateFields });
    res.json({ success: true, message: 'Master song updated', data: { id: songId, ...updateFields } });
  } catch (err) {
    console.error('[songs/master PATCH]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.delete('/master/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const songId = req.params.id;
    await prisma.song.delete({ where: { id: songId } });
    res.json({ success: true, message: 'Master song deleted' });
  } catch (err) {
    console.error('[songs/master DELETE]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /songs/praise-night/:id/duplicate — Duplicate a song within or across programs
router.post('/praise-night/:id/duplicate', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const songId = req.params.id;
    const { targetProgramId, targetPraiseNightId, zoneId } = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }

    const newSongId = `song_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const effectiveTargetProgramId = targetProgramId || targetPraiseNightId || existing.praiseNightId;
    const effectiveZoneId = zoneId || existing.zoneId;

    const rawData = (existing.rawData as Record<string, any>) || {};
    const newRawData = {
      ...rawData,
      id: newSongId,
      praiseNightId: effectiveTargetProgramId,
      programId: effectiveTargetProgramId,
      zoneId: effectiveZoneId,
      duplicatedFrom: songId,
      duplicatedAt: new Date().toISOString(),
    };

    const duplicateData: any = {
      id: newSongId,
      title: existing.title,
      key: existing.key,
      tempo: existing.tempo,
      lyrics: existing.lyrics,
      writer: existing.writer,
      category: existing.category,
      audioFile: existing.audioFile,
      audioUrls: existing.audioUrls,
      conductor: existing.conductor,
      leadSinger: existing.leadSinger,
      drummer: existing.drummer,
      leadKeyboardist: existing.leadKeyboardist,
      bassGuitarist: existing.bassGuitarist,
      solfas: existing.solfas,
      zoneId: effectiveZoneId,
      praiseNightId: effectiveTargetProgramId,
      status: existing.status || 'active',
      isActive: existing.isActive !== false,
      categories: existing.categories,
      rawData: newRawData,
      createdAt: new Date().toISOString(),
    };

    const created = await prisma.song.create({ data: duplicateData });

    res.status(201).json({
      success: true,
      message: 'Song duplicated successfully',
      data: mergeRawRow(created),
    });
  } catch (err) {
    console.error('[songs/praise-night/:id/duplicate]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// GET /songs/:id/lyrics — Get lyrics and synced LRC for a song
router.get('/:id/lyrics', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;

    const song = await prisma.song.findUnique({ where: { id } });

    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }

    const merged = mergeRawRow(song);
    const rawData = (song.rawData as Record<string, any>) || {};

    const karaokeLrcText = rawData.karaokeLrcText || merged.karaokeLrcText || null;
    const syncedLyrics = rawData.syncedLyrics || merged.syncedLyrics || null;
    const lyrics = rawData.lyrics || song.lyrics || merged.lyrics || null;

    res.json({
      success: true,
      data: {
        id,
        karaokeLrcText,
        syncedLyrics,
        lyricsText: lyrics,
        hasSyncedLyrics: Boolean(rawData.hasSyncedLyrics || karaokeLrcText || (syncedLyrics && syncedLyrics.length > 0)),
      },
    });
  } catch (err) {
    console.error('[songs/:id/lyrics:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch lyrics' });
  }
});

// PATCH /songs/:id/lyrics — Save synced LRC or plain lyrics for a song
router.patch('/:id/lyrics', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const { karaokeLrcText, syncedLyrics, lyrics } = req.body || {};
    const now = new Date().toISOString();

    const song = await prisma.song.findUnique({ where: { id } });
    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }

    const rawData = (song.rawData as Record<string, any>) || {};
    const updatedRaw = {
      ...rawData,
      ...(karaokeLrcText !== undefined ? { karaokeLrcText } : {}),
      ...(syncedLyrics !== undefined ? { syncedLyrics } : {}),
      ...(lyrics !== undefined ? { lyrics } : {}),
      hasSyncedLyrics: Boolean(karaokeLrcText || (syncedLyrics && syncedLyrics.length > 0)),
      lyricsUpdatedAt: now,
    };

    const setFields: any = { rawData: updatedRaw };
    if (lyrics !== undefined) setFields.lyrics = lyrics;

    await prisma.song.update({ where: { id }, data: setFields });

    const lyricsData = { id, karaokeLrcText, syncedLyrics, lyrics };
    broadcast('song', id, lyricsData);
    broadcast('song', 'all', lyricsData);

    res.json({
      success: true,
      message: 'Lyrics saved successfully',
      data: lyricsData,
    });
  } catch (err) {
    console.error('[songs/:id/lyrics:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to save lyrics' });
  }
});

// GET /songs/:id — Single song lookup across all song tables
router.get('/:id', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;

    const song = await prisma.song.findUnique({ where: { id } });
    if (song) {
      res.json({ success: true, data: mergeRawRow(song) });
      return;
    }

    res.status(404).json({ success: false, error: 'Song not found' });
  } catch (err) {
    console.error('[songs/:id:GET]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /songs/import-from-ministered — Import songs from ministered songs into repertoire
router.post('/import-from-ministered', requireAuth, requireTenantAdmin, async (req: any, res: any) => {
  try {
    const auth = res.locals.auth;
    const { songIds, praiseNightId } = req.body;
    if (!Array.isArray(songIds) || songIds.length === 0) {
      res.status(400).json({ success: false, error: 'songIds array is required' });
      return;
    }

    const ministeredList = await prisma.song.findMany({
      where: { id: { in: songIds } },
    });

    const isHq = auth.role === 'hq_admin' || auth.isHq;
    const zoneId = auth.effectiveZoneId || auth.zoneId || 'hq';

    let importedCount = 0;
    for (const m of ministeredList) {
      const newId = `song_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const raw = (m.rawData && typeof m.rawData === 'object') ? { ...(m.rawData as any) } : {};
      raw.importedFromMinisteredId = m.id;
      raw.leadSinger = m.leadSinger || raw.leadSinger;
      const mRaw = (m.rawData && typeof m.rawData === 'object') ? (m.rawData as any) : {};
      const conductorGuide = mRaw.conductorGuide || mRaw.conductor_guide || mRaw.solfas || '';
      const history = mRaw.history || '';
      const praiseId = praiseNightId || mRaw.praiseNightId || mRaw.programId || null;

      raw.importedFromMinisteredId = m.id;
      raw.leadSinger = mRaw.leadSinger || raw.leadSinger || '';
      raw.writer = m.writer || raw.writer || '';
      raw.category = m.category || raw.category || 'Praise Night';
      raw.key = m.key || raw.key || '';
      raw.tempo = m.tempo || raw.tempo || '';
      raw.conductorGuide = conductorGuide;
      raw.history = history;
      raw.lyrics = m.lyrics || raw.lyrics || '';
      raw.audioUrls = m.audioUrls || raw.audioUrls || {};
      raw.audioFile = m.audioFile || raw.audioFile || '';
      raw.audioUrl = m.audioFile || raw.audioUrl || '';

      await prisma.song.create({
        data: {
          id: newId,
          title: m.title || 'Untitled Song',
          writer: m.writer || '',
          category: m.category || 'Praise Night',
          key: m.key || '',
          tempo: m.tempo || '',
          lyrics: m.lyrics || '',
          audioFile: m.audioFile || '',
          audioUrls: m.audioUrls || {},
          praiseNightId: praiseId,
          scope: isHq ? 'hq' : 'zone',
          zoneId: isHq ? 'hq' : zoneId,
          rawData: raw,
        },
      });
      importedCount++;
    }

    res.json({
      success: true,
      count: importedCount,
      message: `Successfully imported ${importedCount} song(s) into repertoire.`,
    });
  } catch (err) {
    console.error('[songs/import-from-ministered]', err);
    res.status(500).json({ success: false, error: 'Failed to import songs' });
  }
});

export default router;
