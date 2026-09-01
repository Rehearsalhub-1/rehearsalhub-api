import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

function shapeStatus(row: any, currentUserId?: string) {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.user ? [row.user.firstName, row.user.lastName].filter(Boolean).join(' ') || row.user.email : 'Singer',
    userAvatar: row.user?.avatarUrl || null,
    mediaUrl: row.mediaUrl,
    type: row.type || 'image',
    caption: row.caption || '',
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    viewers: Array.isArray(row.viewers) ? row.viewers : [],
    likes: Array.isArray(row.likes) ? row.likes : [],
    isViewed: currentUserId && Array.isArray(row.viewers) ? row.viewers.includes(currentUserId) : false,
  };
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const currentUserId = res.locals.auth.userId as string;
    const now = new Date();

    const statuses = await prisma.userStatus.findMany({
      where: {
        expiresAt: { gt: now },
      },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: statuses.map((s) => shapeStatus(s, currentUserId)) });
  } catch (error) {
    console.error('[statuses:get]', error);
    res.status(500).json({ success: false, error: 'Failed to load statuses' });
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { mediaUrl, type = 'image', caption = '' } = req.body || {};
    if (typeof mediaUrl !== 'string' || !mediaUrl.trim()) {
      return res.status(400).json({ success: false, error: 'Media URL is required' });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + STATUS_TTL_MS);

    const status = await prisma.userStatus.create({
      data: {
        id: crypto.randomUUID(),
        userId: res.locals.auth.userId as string,
        mediaUrl: mediaUrl.trim(),
        type,
        caption: typeof caption === 'string' ? caption.trim().slice(0, 500) : '',
        expiresAt,
        viewers: [],
        likes: [],
      },
      include: { user: true },
    });

    broadcast('statuses', 'all', { status: shapeStatus(status, res.locals.auth.userId) });
    res.status(201).json({ success: true, data: shapeStatus(status, res.locals.auth.userId) });
  } catch (error) {
    console.error('[statuses:create]', error);
    res.status(500).json({ success: false, error: 'Failed to create status' });
  }
});

router.post('/:id/view', requireAuth, async (req: Request, res: Response) => {
  try {
    const row = await prisma.userStatus.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ success: false, error: 'Status not found' });

    const viewers = Array.isArray(row.viewers) ? [...row.viewers] : [];
    const userId = res.locals.auth.userId as string;
    if (!viewers.includes(userId)) {
      viewers.push(userId);
      await prisma.userStatus.update({
        where: { id: row.id },
        data: { viewers },
      });
    }

    res.json({ success: true, data: { id: row.id, viewers } });
  } catch (error) {
    console.error('[statuses:view]', error);
    res.status(500).json({ success: false, error: 'Failed to mark status viewed' });
  }
});

router.post('/:id/like', requireAuth, async (req: Request, res: Response) => {
  try {
    const row = await prisma.userStatus.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ success: false, error: 'Status not found' });

    const likes = Array.isArray(row.likes) ? [...row.likes] : [];
    const userId = res.locals.auth.userId as string;
    const liked = likes.includes(userId);
    const nextLikes = liked ? likes.filter((id) => id !== userId) : [...likes, userId];

    await prisma.userStatus.update({
      where: { id: row.id },
      data: { likes: nextLikes },
    });

    broadcast('statuses', 'all', { id: row.id, likes: nextLikes });
    res.json({ success: true, data: { id: row.id, likes: nextLikes, liked: !liked } });
  } catch (error) {
    console.error('[statuses:like]', error);
    res.status(500).json({ success: false, error: 'Failed to update status like' });
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const row = await prisma.userStatus.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ success: false, error: 'Status not found' });
    if (row.userId !== res.locals.auth.userId) return res.status(403).json({ success: false, error: 'Forbidden' });

    await prisma.userStatus.delete({ where: { id: row.id } });
    broadcast('statuses', 'all', { deletedId: row.id });
    res.json({ success: true });
  } catch (error) {
    console.error('[statuses:delete]', error);
    res.status(500).json({ success: false, error: 'Failed to delete status' });
  }
});

export default router;
