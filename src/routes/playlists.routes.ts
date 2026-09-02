import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

function shapePlaylist(p: any) {
  const items = Array.isArray(p.items) ? p.items : [];
  const songs = items.map((item: any) => item.song || item);
  const songIds = items.map((item: any) => item.songId || item.id);
  return {
    id: p.id,
    userId: p.userId,
    title: p.title || 'Playlist',
    name: p.title || 'Playlist',
    isPublic: p.isPublic,
    organizationId: p.organizationId,
    songIds,
    songs,
    itemCount: items.length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const rows = await prisma.playlist.findMany({
      where: { userId },
      include: {
        items: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.json({ success: true, count: rows.length, data: rows.map(shapePlaylist) });
  } catch (err) {
    console.error('[playlists/me]', err);
    res.status(500).json({ success: false, error: 'Failed to load your playlists' });
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { name, title, songIds = [], isPublic = false } = req.body;
    const playlistTitle = (title || name || 'New Playlist').trim();
    const id = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newSongIds: string[] = Array.isArray(songIds) ? songIds : [];

    const created = await prisma.playlist.create({
      data: {
        id,
        title: playlistTitle,
        userId,
        isPublic: Boolean(isPublic),
        items: {
          create: newSongIds.map((sId, idx) => ({
            songId: sId,
            order: idx + 1,
          })),
        },
      },
      include: {
        items: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    res.status(201).json({ success: true, data: shapePlaylist(created) });
  } catch (err) {
    console.error('[playlists:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create playlist' });
  }
});

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const row = await prisma.playlist.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!row) return res.status(404).json({ success: false, error: 'Playlist not found' });

    res.json({ success: true, data: shapePlaylist(row) });
  } catch (err) {
    console.error('[playlists/:id:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch playlist' });
  }
});

router.post('/:id/songs', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { songId, songIds } = req.body;
    const toAdd: string[] = Array.isArray(songIds) ? songIds : songId ? [String(songId)] : [];
    if (toAdd.length === 0) return res.status(400).json({ success: false, error: 'songId or songIds required' });

    const existing = await prisma.playlist.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (existing.userId !== (res.locals.auth.userId as string)) return res.status(403).json({ success: false, error: 'Forbidden' });

    const currentSongIds = new Set(existing.items.map((it) => it.songId));
    let nextOrder = existing.items.length + 1;

    for (const sid of toAdd) {
      if (!currentSongIds.has(sid)) {
        await prisma.playlistItem.create({
          data: {
            playlistId: id,
            songId: sid,
            order: nextOrder++,
          },
        });
      }
    }

    const updated = await prisma.playlist.findUnique({
      where: { id },
      include: {
        items: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    res.json({ success: true, data: shapePlaylist(updated) });
  } catch (err) {
    console.error('[playlists/:id/songs:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to add songs to playlist' });
  }
});

router.delete('/:id/songs/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id, songId } = req.params;
    const existing = await prisma.playlist.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (existing.userId !== (res.locals.auth.userId as string)) return res.status(403).json({ success: false, error: 'Forbidden' });

    await prisma.playlistItem.deleteMany({
      where: {
        playlistId: id,
        songId,
      },
    });

    const updated = await prisma.playlist.findUnique({
      where: { id },
      include: {
        items: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    res.json({ success: true, data: shapePlaylist(updated) });
  } catch (err) {
    console.error('[playlists/:id/songs:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to remove song from playlist' });
  }
});

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = res.locals.auth.userId as string;
    const existing = await prisma.playlist.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (existing.userId !== userId) return res.status(403).json({ success: false, error: 'Forbidden' });

    const { title, name, isPublic } = req.body || {};
    const playlistTitle = title ?? name;

    const updated = await prisma.playlist.update({
      where: { id },
      data: {
        ...(playlistTitle !== undefined ? { title: String(playlistTitle).trim() } : {}),
        ...(isPublic !== undefined ? { isPublic: Boolean(isPublic) } : {}),
      },
      include: {
        items: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    res.json({ success: true, data: shapePlaylist(updated) });
  } catch (err) {
    console.error('[playlists/:id:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update playlist' });
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = res.locals.auth.userId as string;
    const existing = await prisma.playlist.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (existing.userId !== userId) return res.status(403).json({ success: false, error: 'Forbidden' });

    await prisma.playlist.delete({ where: { id } });
    res.json({ success: true, message: 'Playlist deleted' });
  } catch (err) {
    console.error('[playlists/:id:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete playlist' });
  }
});

export default router;
