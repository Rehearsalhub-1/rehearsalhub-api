import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';
import { canManageTenant } from '../auth/permissions';

const router = Router();

function shapeMedia(m: any) {
  const thumb = m.thumbnail || m.thumbnailUrl || null;
  return {
    id: m.id,
    title: m.title || m.name || 'Untitled Media',
    name: m.title || m.name || 'Untitled Media',
    url: m.url || m.videoUrl || '',
    videoUrl: m.url || m.videoUrl || '',
    thumbnailUrl: thumb,
    thumbnail: thumb,
    type: (m.type || 'video').toLowerCase(),
    folder: m.folder || 'general',
    size: m.size ? Number(m.size) : 0,
    format: m.mimeType || m.format || null,
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

// Helper to extract videos from media_videos table
async function fetchMediaVideos(limit = 100, search?: string) {
  try {
    let query = `SELECT * FROM media_videos`;
    if (search && search.trim()) {
      const sanitized = search.trim().replace(/'/g, "''");
      query += ` WHERE title ILIKE '%${sanitized}%' OR raw_data->>'title' ILIKE '%${sanitized}%'`;
    }
    query += ` ORDER BY COALESCE(created_at, (raw_data->>'createdAt')::timestamptz, NOW()) DESC LIMIT ${Math.min(limit, 500)}`;

    const rows: any[] = await prisma.$queryRawUnsafe(query);
    if (!Array.isArray(rows)) return [];

    return rows.map((v) => {
      const raw = v.raw_data && typeof v.raw_data === 'object' ? v.raw_data : {};
      const videoUrl = v.video_url || v.videoUrl || v.url || raw.videoUrl || raw.url || raw.mediaUrl || '';
      const thumb = v.thumbnail || v.thumbnailUrl || raw.thumbnail || raw.thumbnailUrl || raw.imageUrl || null;
      const title = v.title || raw.title || raw.name || 'Loveworld Video';
      const views = v.views !== undefined && v.views !== null ? Number(v.views) : (raw.views ? Number(raw.views) : 0);
      const category = v.type || raw.category || raw.genre?.[0] || 'Rehearsal';
      const channel = v.created_by_name || v.createdByName || raw.createdByName || 'Loveworld Singers';
      const createdAt = v.created_at || v.createdAt || raw.createdAt || new Date();

      return {
        id: String(v.id),
        title,
        name: title,
        url: videoUrl,
        videoUrl,
        thumbnailUrl: thumb,
        thumbnail: thumb,
        type: 'video',
        category,
        folder: 'videos',
        views,
        likes: v.likes || raw.likes || 0,
        channelName: channel,
        createdAt,
        updatedAt: createdAt,
      };
    });
  } catch (err: any) {
    console.warn('[media_videos query]:', err?.message);
    return [];
  }
}

// GET /media - List media
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { folder, type, zoneId, limit, search } = req.query as Record<string, string>;
    const effectiveZoneId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const takeCount = limit ? Math.min(parseInt(limit, 10), 500) : 100;

    // 1. Fetch from media_videos (Primary Video Library)
    const videoTableRows = (!type || type === 'all' || type.toLowerCase() === 'video')
      ? await fetchMediaVideos(takeCount, search)
      : [];

    // 2. Fetch from media_assets table
    const whereClause: any = {
      OR: [
        ...(effectiveZoneId ? [{ organizationId: effectiveZoneId }] : []),
        { organizationId: 'zone-001' },
        { organizationId: null },
      ],
    };

    if (folder && folder !== 'all') {
      whereClause.folder = folder;
    }

    if (type && type !== 'all') {
      whereClause.type = {
        in: [type.toLowerCase(), type.toUpperCase(), type, type.charAt(0).toUpperCase() + type.slice(1)],
      };
    }

    if (search && search.trim()) {
      whereClause.title = {
        contains: search.trim(),
        mode: 'insensitive',
      };
    }

    const assets = await prisma.mediaAsset.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: takeCount,
    });

    const shapedAssets = assets.map(shapeMedia);

    // 3. Deduplicate and merge (videos from media_videos + uploaded assets)
    const seenIds = new Set<string>();
    const combined: any[] = [];

    for (const item of [...videoTableRows, ...shapedAssets]) {
      if (item && item.id && !seenIds.has(String(item.id))) {
        seenIds.add(String(item.id));
        combined.push(item);
      }
    }

    res.json({ success: true, count: combined.length, data: combined });
  } catch (err) {
    console.error('[media:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load media assets' });
  }
});

// GET /media/categories - List media folders/categories
router.get('/categories', requireAuth, async (_req: Request, res: Response) => {
  try {
    const defaultCategories = ['Rehearsal', 'Praise Night', 'Communion', 'Live', 'Music Videos', 'Special Events'];
    res.json({ success: true, count: defaultCategories.length, data: defaultCategories.map((name) => ({ name, title: name })) });
  } catch (err) {
    res.json({ success: true, count: 0, data: [] });
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
