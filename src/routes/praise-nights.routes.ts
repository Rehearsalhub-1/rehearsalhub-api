import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

function shapeProgram(p: any) {
  const programSongsList = Array.isArray(p.programSongs)
    ? p.programSongs
        .sort((a: any, b: any) => (a.order ?? 9999) - (b.order ?? 9999))
        .map((ps: any, index: number) => {
          const s = ps.song || ps;
          return {
            id: s.id,
            praiseNightId: p.id,
            programId: p.id,
            order: ps.order !== undefined && ps.order !== null ? ps.order : index + 1,
            title: s.title || 'Untitled Song',
            key: s.key || null,
            tempo: s.tempo || null,
            lyrics: s.lyrics || '',
            solfas: s.solfas || '',
            solfa: s.solfas || '',
            writer: s.writer || '',
            leadSinger: s.leadSinger || s.lead_singer || 'Loveworld Singers',
            conductor: s.conductor || '',
            conductorGuide: s.conductor || '',
            drummer: s.drummer || '',
            leadKeyboardist: s.leadKeyboardist || s.lead_keyboardist || '',
            leadGuitarist: s.leadGuitarist || s.lead_guitarist || '',
            bassGuitarist: s.bassGuitarist || s.bass_guitarist || '',
            audioFile: s.audioFile || s.audio_file || s.audioUrl || s.audio_url || '',
            audioUrl: s.audioUrl || s.audio_url || s.audioFile || s.audio_file || '',
            audioUrls: s.audioUrls || s.audio_urls || null,
            category: s.category || 'Previously ministered praise songs',
            status: s.status || 'unheard',
            isMaster: Boolean(s.isMaster || s.is_master),
            isMinistered: Boolean(s.isMinistered || s.is_ministered),
            rehearsalCount: s.rehearsalCount || s.rehearsal_count || 0,
            organizationId: s.organizationId || s.organization_id || null,
            groupId: s.groupId || s.group_id || null,
            createdAt: s.createdAt || s.created_at,
            updatedAt: s.updatedAt || s.updated_at,
          };
        })
    : [];

  const heardCount = programSongsList.filter((s: any) => s.status === 'heard').length;

  return {
    id: p.id,
    name: p.name,
    date: p.date,
    category: p.category || 'pre-rehearsal',
    status: p.status || p.category || 'pre-rehearsal',
    pageCategory: p.pageCategory || p.page_category || null,
    isActive: typeof p.isActive === 'boolean' ? p.isActive : p.category === 'ongoing',
    isArchived: typeof p.isArchived === 'boolean' ? p.isArchived : p.category === 'archive',
    organizationId: p.organizationId || p.organization_id || null,
    groupId: p.groupId || p.group_id || null,
    location: p.location || null,
    bannerImage: p.bannerImage || p.banner_image || null,
    songCount: programSongsList.length || (p.rehearsalCount || 0),
    heardCount,
    songs: programSongsList,
    createdAt: p.createdAt || p.created_at,
    updatedAt: p.updatedAt || p.updated_at,
  };
}

// GET /programs or /praise-nights
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId, category, groupId, subGroupId, includeChurch } = req.query as {
      zoneId?: string;
      category?: string;
      groupId?: string;
      subGroupId?: string;
      includeChurch?: string;
    };
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin' || Boolean(auth.hasHqAccess);
    const targetZone = zoneId || req.tenant?.effectiveZoneId;
    const targetGroup = groupId || subGroupId || null;

    const where: any = {};
    if (category && category !== 'all') {
      where.category = category;
    }

    // Isolate church/subgroup programs:
    // If a specific church is requested, filter by that groupId.
    // Otherwise, for general Repertoire view, only return main programs (groupId is null).
    if (targetGroup) {
      where.groupId = targetGroup;
    } else if (includeChurch !== 'true') {
      where.groupId = null;
    }

    if (targetZone && targetZone !== 'all' && targetZone !== 'global') {
      where.OR = [
        { organizationId: targetZone },
        { organizationId: 'zone-001' },
      ];
    } else if (!isHqAdmin && targetZone) {
      where.organizationId = targetZone;
    }

    const programs = await prisma.program.findMany({
      where,
      include: {
        programSongs: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, count: programs.length, data: programs.map(shapeProgram) });
  } catch (err) {
    console.error('[programs]', err);
    res.status(500).json({ success: false, error: 'Failed to load programs' });
  }
});

// GET /programs/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const row = await prisma.program.findUnique({
      where: { id: req.params.id },
      include: {
        programSongs: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!row) {
      res.status(404).json({ success: false, error: 'Program not found' });
      return;
    }
    res.json({ success: true, data: shapeProgram(row) });
  } catch (err) {
    console.error('[programs/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load program' });
  }
});

// POST /programs or /praise-nights — Create program
router.post('/', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { name, date, zoneId, category, status, location, bannerImage, songIds } = req.body;
    const programId = req.body.id || `prog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveCategory = category || (status === 'ongoing' ? 'ongoing' : status === 'archive' ? 'archive' : 'pre-rehearsal');
    const effectiveStatus = status || effectiveCategory;
    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    const row = await prisma.program.create({
      data: {
        id: programId,
        name: name || 'Program',
        date: date || new Date().toISOString().split('T')[0],
        organizationId: orgId,
        category: effectiveCategory,
        status: effectiveStatus,
        isActive: effectiveStatus === 'ongoing',
        isArchived: effectiveStatus === 'archive',
        location: location || null,
        bannerImage: bannerImage || null,
        ...(Array.isArray(songIds) && songIds.length > 0
          ? {
              programSongs: {
                create: songIds.map((sId: string, idx: number) => ({
                  songId: sId,
                  order: idx + 1,
                })),
              },
            }
          : {}),
      },
      include: {
        programSongs: {
          include: { song: true },
        },
      },
    });

    res.status(201).json({ success: true, message: 'Program created successfully', data: shapeProgram(row) });
  } catch (err) {
    console.error('[programs/create]', err);
    res.status(500).json({ success: false, error: 'Failed to create program' });
  }
});

// PATCH /programs/:id or /praise-nights/:id — Full program update
router.patch('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      title,
      date,
      location,
      description,
      category,
      status,
      isActive,
      isArchived,
      bannerImage,
      banner,
      organizationId,
      zoneId,
      days,
      hours,
      minutes,
      seconds,
    } = req.body;

    const existing = await prisma.program.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Program not found' });
      return;
    }

    const nextStatus = status || (category ? category : existing.status);
    const nextCategory = category || (status ? status : existing.category);
    const nextIsActive = typeof isActive === 'boolean' ? isActive : nextCategory === 'ongoing';
    const nextIsArchived = typeof isArchived === 'boolean' ? isArchived : nextCategory === 'archive';

    const updated = await prisma.program.update({
      where: { id },
      data: {
        name: (name || title || '').trim() || undefined,
        date: date || undefined,
        location: location !== undefined ? location : undefined,
        status: nextStatus || undefined,
        category: nextCategory || undefined,
        isActive: nextIsActive,
        isArchived: nextIsArchived,
        bannerImage: bannerImage || banner || undefined,
        organizationId: organizationId || zoneId || undefined,
      },
      include: {
        programSongs: {
          include: { song: true },
        },
      },
    });

    res.json({ success: true, message: 'Program updated successfully', data: shapeProgram(updated) });
  } catch (err: any) {
    console.error('[programs/:id:patch]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update program' });
  }
});

// PATCH /programs/:id/status — Toggle program status
router.patch('/:id/status', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { status, category } = req.body;
    const targetStatus = status || category;
    if (!targetStatus) {
      res.status(400).json({ success: false, error: 'Missing status' });
      return;
    }
    const isOngoing = targetStatus === 'ongoing';
    const isArchive = targetStatus === 'archive' || targetStatus === 'archived';

    const updated = await prisma.program.update({
      where: { id: req.params.id },
      data: {
        status: targetStatus,
        category: isOngoing ? 'ongoing' : isArchive ? 'archive' : 'pre-rehearsal',
        isActive: isOngoing,
        isArchived: isArchive,
      },
      include: {
        programSongs: {
          include: { song: true },
        },
      },
    });

    res.json({ success: true, message: `Program status updated to ${targetStatus}`, data: shapeProgram(updated) });
  } catch (err) {
    console.error('[programs/:id/status]', err);
    res.status(500).json({ success: false, error: 'Failed to update program status' });
  }
});

// POST /programs/:id/duplicate — Duplicate a program & its song list
router.post('/:id/duplicate', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id;
    const { newName, newDate, targetZoneId } = req.body;

    const source = await prisma.program.findUnique({
      where: { id: sourceId },
      include: { programSongs: true },
    });

    if (!source) {
      res.status(404).json({ success: false, error: 'Source program not found' });
      return;
    }

    const newId = `prog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveZoneId = targetZoneId || source.organizationId;

    const newProg = await prisma.program.create({
      data: {
        id: newId,
        name: newName || `${source.name} (Copy)`,
        date: newDate || new Date().toISOString().split('T')[0],
        organizationId: effectiveZoneId,
        category: 'pre-rehearsal',
        status: 'pre-rehearsal',
        isActive: false,
        isArchived: false,
        location: source.location,
        bannerImage: source.bannerImage,
        programSongs: {
          create: source.programSongs.map((ps) => ({
            songId: ps.songId,
            order: ps.order,
          })),
        },
      },
      include: {
        programSongs: {
          include: { song: true },
        },
      },
    });

    res.json({
      success: true,
      message: 'Program duplicated successfully',
      data: shapeProgram(newProg),
    });
  } catch (err) {
    console.error('[programs/:id/duplicate]', err);
    res.status(500).json({ success: false, error: 'Failed to duplicate program' });
  }
});

// DELETE /programs/:id
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.program.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Program deleted' });
  } catch (err) {
    console.error('[programs/delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete program' });
  }
});

export default router;
