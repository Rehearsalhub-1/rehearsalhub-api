import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

function shapeProgram(p: any) {
  const programSongsList = Array.isArray(p.programSongs)
    ? p.programSongs.map((ps: any) => {
        const s = ps.song || ps;
        return {
          id: s.id,
          praiseNightId: p.id,
          programId: p.id,
          order: ps.order !== undefined ? ps.order : null,
          title: s.title || 'Untitled Song',
          key: s.key || null,
          tempo: s.tempo || null,
          lyrics: s.lyrics || '',
          solfas: s.solfas || '',
          solfa: s.solfas || '',
          writer: s.writer || '',
          leadSinger: s.leadSinger || 'Loveworld Singers',
          conductor: s.conductor || '',
          conductorGuide: s.conductor || '',
          drummer: s.drummer || '',
          leadKeyboardist: s.leadKeyboardist || '',
          leadGuitarist: s.leadGuitarist || '',
          bassGuitarist: s.bassGuitarist || '',
          audioFile: s.audioFile || s.audioUrl || '',
          audioUrl: s.audioUrl || s.audioFile || '',
          audioUrls: s.audioUrls || null,
          category: s.category || 'Previously ministered praise songs',
          status: s.status || 'active',
          isMaster: Boolean(s.isMaster),
          isMinistered: Boolean(s.isMinistered),
          rehearsalCount: s.rehearsalCount || 0,
          organizationId: s.organizationId || null,
          groupId: s.groupId || null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        };
      })
    : [];

  return {
    id: p.id,
    name: p.name,
    date: p.date,
    category: p.category || 'pre-rehearsal',
    status: p.status || 'pre-rehearsal',
    isActive: p.isActive,
    isArchived: p.isArchived,
    organizationId: p.organizationId,
    groupId: p.groupId,
    location: p.location || null,
    bannerImage: p.bannerImage || null,
    songCount: programSongsList.length || (p.rehearsalCount || 0),
    songs: programSongsList,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// GET /programs or /praise-nights
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId, category } = req.query as { zoneId?: string; category?: string };
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin' || Boolean(auth.hasHqAccess);
    const targetZone = zoneId || req.tenant?.effectiveZoneId;

    const where: any = {};
    if (category && category !== 'all') {
      where.category = category;
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
        description: description !== undefined ? description : undefined,
        status: nextStatus || undefined,
        category: nextCategory || undefined,
        isActive: nextIsActive,
        isArchived: nextIsArchived,
        bannerImage: bannerImage || banner || undefined,
        organizationId: organizationId || zoneId || undefined,
        days: typeof days === 'number' ? days : undefined,
        hours: typeof hours === 'number' ? hours : undefined,
        minutes: typeof minutes === 'number' ? minutes : undefined,
        seconds: typeof seconds === 'number' ? seconds : undefined,
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
