import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';
import { canManageTenant } from '../auth/permissions';

const router = Router();

function shapeMedia(m: any) {
  return {
    id: m.id,
    title: m.title,
    name: m.title,
    url: m.url,
    videoUrl: m.url,
    thumbnailUrl: m.thumbnailUrl,
    thumbnail: m.thumbnailUrl,
    type: m.type || 'audio',
    folder: m.folder || 'general',
    size: m.size || 0,
    format: m.format || null,
    views: m.views || 0,
    likes: m.likes || 0,
    organizationId: m.organizationId || null,
    zoneId: m.organizationId || 'global',
    groupId: m.groupId || null,
    subgroupId: m.groupId || null,
    churchId: m.groupId || null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

// GET /media - List media
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { folder, type } = req.query as Record<string, string>;
    const effectiveZoneId = req.tenant?.effectiveZoneId || 'zone-001';

    const assets = await prisma.mediaAsset.findMany({
      where: {
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
          { organizationId: null },
        ],
        ...(folder && folder !== 'all' ? { folder } : {}),
        ...(type && type !== 'all' ? { type } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.json({ success: true, count: assets.length, data: assets.map(shapeMedia) });
  } catch (err) {
    console.error('[media:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load media assets' });
  }
});

// GET /media/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: req.params.id } });
    if (!asset) return res.status(404).json({ success: false, error: 'Media not found' });
    res.json({ success: true, data: shapeMedia(asset) });
  } catch (err) {
    console.error('[media:get:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load media asset' });
  }
});

// POST /media - Create media item
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const id = body.id || `media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const orgId = body.organizationId || body.zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    const created = await prisma.mediaAsset.create({
      data: {
        id,
        title: (body.title || body.name || 'Untitled Media').trim(),
        url: body.url || body.videoUrl || '',
        thumbnail: body.thumbnailUrl || body.thumbnail || null,
        type: body.type || 'audio',
        folder: body.folder || 'general',
        size: Number(body.size) || null,
        mimeType: body.format || body.mimeType || null,
        organizationId: orgId,
        groupId: body.groupId || body.subgroupId || null,
      },
    });

    broadcast('media', id, shapeMedia(created));
    res.status(201).json({ success: true, data: shapeMedia(created) });
  } catch (err) {
    console.error('[media:post]', err);
    res.status(500).json({ success: false, error: 'Failed to create media' });
  }
});

// PATCH /media/:id - Update media item
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = res.locals.auth;
    if (!canManageTenant(auth?.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const updates = req.body || {};
    const updateData: any = {};
    if (updates.title !== undefined || updates.name !== undefined) updateData.title = (updates.title || updates.name).trim();
    if (updates.url !== undefined || updates.videoUrl !== undefined) updateData.url = updates.url || updates.videoUrl;
    if (updates.thumbnailUrl !== undefined || updates.thumbnail !== undefined) updateData.thumbnail = updates.thumbnailUrl || updates.thumbnail;
    if (updates.type !== undefined) updateData.type = updates.type;
    if (updates.folder !== undefined) updateData.folder = updates.folder;
    if (updates.views !== undefined) updateData.views = Number(updates.views);
    if (updates.likes !== undefined) updateData.likes = Number(updates.likes);

    const updated = await prisma.mediaAsset.update({
      where: { id },
      data: updateData,
    });

    broadcast('media', id, shapeMedia(updated));
    res.json({ success: true, data: shapeMedia(updated) });
  } catch (err) {
    console.error('[media:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update media' });
  }
});

// DELETE /media/:id - Delete media item
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = res.locals.auth;
    if (!canManageTenant(auth?.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    await prisma.mediaAsset.delete({ where: { id } });
    broadcast('media', id, { id, deleted: true });
    res.json({ success: true, data: { id, deleted: true } });
  } catch (err) {
    console.error('[media:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete media' });
  }
});

export default router;
