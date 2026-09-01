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
        items: true,
      },
    });

    const songs = new Set<string>();
    for (const row of rows) {
      if (row.items && row.items.length > 0) {
        for (const it of row.items) songs.add(it.songId);
      }
    }

    res.json({ success: true, data: { songs: Array.from(songs) } });
  } catch (err) {
    console.error('[favorites/me]', err);
    res.status(500).json({ success: false, error: 'Failed to load favorite songs' });
  }
});

export default router;
