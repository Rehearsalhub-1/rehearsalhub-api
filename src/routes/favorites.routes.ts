import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

/** GET /favorites/me */
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const rows = await prisma.playlist.findMany({
      where: {
        userId,
        OR: [
          { title: { contains: 'favorite', mode: 'insensitive' } },
          { id: { contains: 'favorite' } },
        ],
      },
      include: {
        items: {
          include: {
            song: true,
          },
        },
      },
    });

    const songIdSet = new Set<string>();
    const fullSongs: any[] = [];

    for (const row of rows) {
      if (row.items && row.items.length > 0) {
        for (const it of row.items) {
          if (!songIdSet.has(it.songId)) {
            songIdSet.add(it.songId);
            if (it.song) fullSongs.push(it.song);
          }
        }
      }
    }

    const songIds = Array.from(songIdSet);

    res.json({
      success: true,
      data: {
        songs: songIds,
        songIds,
        songList: fullSongs,
      },
    });
  } catch (err) {
    console.error('[favorites/me]', err);
    res.status(500).json({ success: false, error: 'Failed to load favorite songs' });
  }
});

/** POST /favorites — Add a song to favorites */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { songId } = req.body;
    if (!songId) return res.status(400).json({ success: false, error: 'songId is required' });

    const favPlaylistId = `favorites_${userId}`;
    await prisma.playlist.upsert({
      where: { id: favPlaylistId },
      update: {},
      create: {
        id: favPlaylistId,
        title: 'Favorites',
        userId,
        isPublic: false,
      },
    });

    await prisma.playlistItem.upsert({
      where: {
        playlistId_songId: { playlistId: favPlaylistId, songId: String(songId) },
      },
      update: {},
      create: {
        playlistId: favPlaylistId,
        songId: String(songId),
        order: 1,
      },
    });

    res.json({ success: true, message: 'Song added to favorites' });
  } catch (err: any) {
    console.error('[favorites/post]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to add favorite' });
  }
});

/** DELETE /favorites/:songId — Remove a song from favorites */
router.delete('/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { songId } = req.params;

    const favPlaylistId = `favorites_${userId}`;
    await prisma.playlistItem.deleteMany({
      where: {
        playlistId: favPlaylistId,
        songId: String(songId),
      },
    });

    res.json({ success: true, message: 'Song removed from favorites' });
  } catch (err: any) {
    console.error('[favorites/delete]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to remove favorite' });
  }
});

export default router;
