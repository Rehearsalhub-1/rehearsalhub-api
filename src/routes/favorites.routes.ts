import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { asStringArray, mergeRawRow } from '../lib/rawRow';

const router = Router();

/** GET /favorites/me */
router.get('/me', requireAuth, async (req, res) => {
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
      const merged = mergeRawRow(row);
      const fromSongIds = asStringArray(merged.songIds ?? merged.songs ?? row.songIds ?? row.songs);
      if (fromSongIds.length > 0) {
        for (const id of fromSongIds) songs.add(id);
      } else if (typeof merged.songId === 'string' && merged.songId) {
        songs.add(merged.songId);
      }
    }

    res.json({ success: true, data: { songs: Array.from(songs) } });
  } catch (err) {
    console.error('[favorites/me]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

export default router;
