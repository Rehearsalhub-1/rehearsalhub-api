import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { mergeRawRow } from '../lib/rawRow';

const router = Router();

// GET /api/praise-night-songs
router.get('/', async (req: Request, res: Response) => {
  try {
    const { praiseNightId, programId, zoneId } = req.query;
    const targetProgramId = (programId || praiseNightId) as string | undefined;

    let rows: any[] = [];

    if (targetProgramId) {
      // Query by programId direct column + rawData fallbacks
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM songs
         WHERE praise_night_id = $1
            OR raw_data->>'praiseNightId' = $1
            OR raw_data->>'programId' = $1
            OR raw_data->>'praise_night_id' = $1
         ORDER BY title ASC`,
        targetProgramId
      );
    } else if (zoneId) {
      rows = await prisma.song.findMany({
        where: { organizationId: zoneId as string },
        orderBy: { title: 'asc' },
      });
    } else {
      rows = await prisma.song.findMany({ orderBy: { title: 'asc' } });
    }

    res.json({ success: true, count: rows.length, data: rows.map(mergeRawRow) });
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
    res.json({ success: true, data: mergeRawRow(song) });
  } catch (error) {
    console.error('Error fetching song:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch song' });
  }
});

export default router;
