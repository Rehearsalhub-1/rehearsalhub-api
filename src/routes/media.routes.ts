import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';
import { broadcast } from '../ws/wsServer';
import { canManageTenant, isHQRole } from '../auth/permissions';

const router = Router();

function parseIsoDate(val: any): string {
  if (!val) return new Date().toISOString();
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && typeof val._seconds === 'number') {
    return new Date(val._seconds * 1000).toISOString();
  }
  if (val instanceof Date) return val.toISOString();
  return new Date().toISOString();
}

function normalizeAsset(row: any, source: 'media_videos' | 'media_assets' | 'zone_media_assets'): any {
  const m = mergeRawRow(row);
  const url = String(m.url || m.videoUrl || m.video_url || '');
  const thumbnail = typeof m.thumbnail === 'string' ? m.thumbnail : null;
  const title = String(m.title || m.name || 'Untitled Asset');
  
  let detectedType = m.type || 'video';
  const lowerUrl = url.toLowerCase();
  const lowerTitle = title.toLowerCase();

  if (detectedType === 'audio' || lowerUrl.match(/\.(mp3|wav|m4a|aac|ogg|flac|wma|3gp)$/) || lowerTitle.match(/\.(mp3|wav|m4a|aac|ogg|flac|wma|3gp)$/)) {
    detectedType = 'audio';
  } else if (detectedType === 'image' || lowerUrl.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|pdf)$/) || lowerTitle.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|pdf)$/)) {
    detectedType = 'image';
  } else if (detectedType === 'video' || lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be') || lowerUrl.match(/\.(mp4|webm|mov|mkv)$/)) {
    detectedType = 'video';
  } else {
    detectedType = 'video';
  }

  const isYt = Boolean(
    (m.isYoutube ?? m.is_youtube) ||
    lowerUrl.includes('youtube.com') ||
    lowerUrl.includes('youtu.be')
  );

  return {
    id: String(m.id),
    title,
    name: title,
    description: typeof m.description === 'string' ? m.description : '',
    url,
    videoUrl: url,
    type: detectedType,
    thumbnail,
    size: typeof m.size === 'number' ? m.size : null,
    format: typeof m.format === 'string' ? m.format : null,
    folder: typeof m.folder === 'string' ? m.folder : 'general',
    forHq: Boolean(m.forHq ?? m.for_hq ?? m.isHqOnly),
    isYoutube: isYt,
    featured: Boolean(m.featured),
    views: typeof m.views === 'number' ? m.views : 0,
    likes: typeof m.likes === 'number' ? m.likes : 0,
    zoneId: typeof m.zoneId === 'string' ? m.zoneId : String(m.zone_id || 'global'),
    createdBy: typeof m.createdBy === 'string' ? m.createdBy : String(m.created_by || ''),
    createdByName: typeof m.createdByName === 'string' ? m.createdByName : String(m.created_by_name || ''),
    createdAt: parseIsoDate(m.createdAt || m.created_at),
    updatedAt: parseIsoDate(m.updatedAt || m.updated_at),
    source,
    rawData: m.rawData ?? null,
  };
}

// In-memory cache for media assets
let cachedMediaAssets: any[] | null = null;
let lastMediaCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

export function invalidateMediaCache() {
  cachedMediaAssets = null;
  lastMediaCacheTime = 0;
}

async function loadAllMediaAssets(): Promise<any[]> {
  const now = Date.now();
  if (cachedMediaAssets && now - lastMediaCacheTime < CACHE_TTL_MS) {
    return cachedMediaAssets;
  }

  const assetRows = await prisma.mediaAsset.findMany();
  const combined = assetRows.map((r) => normalizeAsset(r, 'media_assets'));
  combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  cachedMediaAssets = combined;
  lastMediaCacheTime = now;
  return combined;
}

// GET /media/stats - Summary counts across all media assets
router.get('/stats', requireAuth, async (_req, res) => {
  try {
    const all = await loadAllMediaAssets();
    const videoCount = all.filter((m) => m.type === 'video').length;
    const audioCount = all.filter((m) => m.type === 'audio').length;
    const imageCount = all.filter((m) => m.type === 'image').length;

    res.json({
      success: true,
      data: {
        total: all.length,
        audio: audioCount,
        video: videoCount,
        image: imageCount,
        mediaVideos: all.filter((m) => m.source === 'media_videos').length,
        mediaAssets: all.filter((m) => m.source === 'media_assets').length,
        zoneMediaAssets: all.filter((m) => m.source === 'zone_media_assets').length,
      },
    });
  } catch (err) {
    console.error('[media:stats]', err);
    res.status(500).json({ success: false, error: 'Failed to compute stats' });
  }
});

// GET /media - List media with filtering, search, and scalable pagination
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const { zoneId: requestedZoneId, type, search, featured, isHqOnly, limit, page = '1' } = req.query;
    const allAssets = await loadAllMediaAssets();
    const tenant = req.tenant;
    const zoneId = tenant?.isHQAdmin ? requestedZoneId : tenant?.effectiveZoneId;

    let data = allAssets;

    if (!tenant?.isHQAdmin) {
      data = data.filter((item) => {
        if (item.forHq || item.isHqOnly) return false;
        if (!item.zoneId || item.zoneId === 'global') return true;
        return item.zoneId === zoneId;
      });
    }

    if (type && type !== 'all') {
      data = data.filter((item) => item.type === type);
    }
    if (zoneId && zoneId !== 'all' && zoneId !== 'global') {
      const target = String(zoneId).toLowerCase();
      const withoutHyphen = target.replace(/-/g, '');
      const withHyphen = target.includes('-') ? target : target.replace(/^zone(\d+)$/, 'zone-$1');

      data = data.filter((item) => {
        if (item.forHq || (item as any).isHqOnly) return false;

        const itemZone = (item.zoneId || '').toLowerCase();
        const itemWithoutHyphen = itemZone.replace(/-/g, '');

        return (
          itemZone === target ||
          itemZone === withHyphen ||
          itemWithoutHyphen === withoutHyphen ||
          (!item.zoneId && !item.forHq) ||
          itemZone === 'global'
        );
      });
    }
    if (featured === 'true') {
      data = data.filter((item) => item.featured);
    }
    if (isHqOnly === 'true') {
      data = data.filter((item) => item.forHq);
    }
    if (search && typeof search === 'string' && search.trim()) {
      const q = search.toLowerCase().trim();
      data = data.filter(
        (item) =>
          (item.title && item.title.toLowerCase().includes(q)) ||
          (item.description && item.description.toLowerCase().includes(q)) ||
          (item.url && item.url.toLowerCase().includes(q)) ||
          (item.format && item.format.toLowerCase().includes(q))
      );
    }

    const totalMatching = data.length;

    let finalData = data;
    const pageNum = Math.max(Number(page) || 1, 1);
    
    if (limit) {
      const limitNum = Math.min(Number(limit) || 200, 20000);
      const offset = (pageNum - 1) * limitNum;
      finalData = data.slice(offset, offset + limitNum);
    }

    res.json({
      success: true,
      count: finalData.length,
      total: totalMatching,
      grandTotal: allAssets.length,
      page: pageNum,
      totalPages: limit ? Math.ceil(totalMatching / Math.max(Number(limit) || 200, 1)) : 1,
      data: finalData,
    });
  } catch (err) {
    console.error('[media:get]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch media' });
  }
});

// GET /media/categories - List media categories
router.get('/categories', requireAuth, async (_req, res) => {
  try {
    const rows = await prisma.category.findMany({ where: { type: 'media' } });
    const data = rows.map((r) => {
      const m = mergeRawRow(r);
      return {
        id: String(m.id),
        name: m.name || 'Category',
        slug: m.slug || String(m.name || '').toLowerCase().replace(/\s+/g, '-'),
        order: typeof m.order === 'number' ? m.order : 0,
        rawData: m.rawData ?? null,
      };
    });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[media:categories:get]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch media categories' });
  }
});

// GET /media/:id - Single media item
router.get('/:id', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const tenant = req.tenant;

    const canView = (item: any): boolean => {
      if (tenant?.isHQAdmin) return true;
      if (item.forHq || item.isHqOnly) return false;
      return !item.zoneId || item.zoneId === 'global' || item.zoneId === tenant?.effectiveZoneId;
    };

    const assetRow = await prisma.mediaAsset.findUnique({ where: { id } });
    if (assetRow) {
      const item = normalizeAsset(assetRow, 'media_assets');
      return canView(item) ? res.json({ success: true, data: item }) : res.status(404).json({ success: false, error: 'Media not found' });
    }

    res.status(404).json({ success: false, error: 'Media not found' });
  } catch (err) {
    console.error('[media:get:id]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch media item' });
  }
});

// POST /media - Create media item
router.post('/', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const body = req.body || {};
    const id = body.id || `media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const rawData = {
      ...body,
      id,
      createdAt: now,
      updatedAt: now,
    };

    const created = await prisma.mediaAsset.create({
      data: {
        id,
        title: body.title || 'Untitled Media',
        type: body.type || 'audio',
        folder: body.folder || 'audio',
        scope: body.scope || 'hq',
        zoneId: body.zoneId || null,
        subgroupId: body.subgroupId || null,
        rawData,
      },
    });

    invalidateMediaCache();
    broadcast('media', 'all', rawData);
    broadcast('media', id, rawData);

    res.status(201).json({
      success: true,
      data: normalizeAsset(created, 'media_assets'),
    });
  } catch (err) {
    console.error('[media:post]', err);
    res.status(500).json({ success: false, error: 'Failed to create media' });
  }
});

// PATCH /media/:id - Update media item
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const auth = res.locals.auth;
    const role = String(auth?.role || '').toLowerCase();
    const canManageMedia = canManageTenant(role);
    if (!canManageMedia) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    const existing = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Media item not found' });
    }

    const m = mergeRawRow(existing);
    const updates = req.body;
    const tenant = (req as any).tenant;
    const now = new Date().toISOString();

    const updatedRaw = {
      ...m,
      ...updates,
      updatedAt: now,
    };

    const updated = await prisma.mediaAsset.update({
      where: { id },
      data: {
        title: updates.title !== undefined ? updates.title : existing.title,
        type: updates.type !== undefined ? updates.type : existing.type,
        rawData: updatedRaw,
      },
    });

    invalidateMediaCache();
    broadcast('media', 'all', updatedRaw);
    broadcast('media', id, updatedRaw);

    res.json({ success: true, data: normalizeAsset(updated, 'media_assets') });
  } catch (err) {
    console.error('[media:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update media' });
  }
});

// DELETE /media/:id - Delete media item
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const auth = res.locals.auth;
    const role = String(auth?.role || '').toLowerCase();
    const canManageMedia = canManageTenant(role);
    if (!canManageMedia) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const existing = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Media not found' });
      return;
    }
    const tenant = (req as any).tenant;
    if (!isHQRole(role)) {
      if (existing.zoneId && existing.zoneId !== tenant?.effectiveZoneId) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
    }

    await prisma.mediaAsset.deleteMany({ where: { id } });

    invalidateMediaCache();
    broadcast('media', 'all', { id, deleted: true });
    broadcast('media', id, { id, deleted: true });

    res.json({ success: true, data: { id, deleted: true } });
  } catch (err) {
    console.error('[media:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete media' });
  }
});

export default router;
