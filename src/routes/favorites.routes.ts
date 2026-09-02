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

export default router;
