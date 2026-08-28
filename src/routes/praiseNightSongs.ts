import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';

const router = Router();

// GET /api/praise-night-songs
router.get('/', async (req: Request, res: Response) => {
  try {
    const { praiseNightId, zoneId } = req.query;
    const where: any = {};
    if (praiseNightId) {
      where.programSongs = { some: { programId: praiseNightId as string } };
    } else if (zoneId) {
      where.organizationId = zoneId as string;
    }

    const rows = await prisma.song.findMany({
      where,
      select: { id: true, title: true, key: true, tempo: true, category: true, writer: true, conductor: true, leadSinger: true, drummer: true, audioFile: true, audioUrls: true, lyrics: true, categories: true, status: true, isActive: true, organizationId: true, rawData: true, createdAt: true, updatedAt: true },
    });

    res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error('Error fetching praise night songs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch praise night songs' });
  }
});

// GET /api/praise-night-songs/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const song = await prisma.song.findUnique({ where: { id: req.params.id } });
    if (!song) return res.status(404).json({ success: false, error: 'Song not found' });
    res.json({ success: true, data: song });
  } catch (error) {
    console.error('Error fetching song:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch song' });
  }
});

export default router;
