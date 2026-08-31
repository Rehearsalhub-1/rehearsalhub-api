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
  const rawVideoUrl = String(m.videoUrl || m.video_url || m.youtubeUrl || m.youtube_url || '');
  const url = String(m.url || rawVideoUrl || '');
  const thumbnail = typeof m.thumbnail === 'string' ? m.thumbnail : (typeof m.thumbnailUrl === 'string' ? m.thumbnailUrl : null);
  const title = String(m.name || m.title || 'Untitled Asset');
  
  let detectedType = String(m.type || m.mediaType || m.category || '').toLowerCase();
  const lowerUrl = url.toLowerCase();
  const lowerTitle = title.toLowerCase();

  if (rawVideoUrl || lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be') || lowerUrl.match(/\.(mp4|webm|mov|mkv)$/) || lowerUrl.includes('/videos/') || detectedType === 'video') {
    detectedType = 'video';
  } else if (detectedType === 'audio' || lowerUrl.match(/\.(mp3|wav|m4a|aac|ogg|flac|wma|3gp)$/) || lowerUrl.includes('/audio/')) {
    detectedType = 'audio';
  } else if (detectedType === 'image' || lowerUrl.match(/\.(jpg|jpeg|png|gif|webp|svg|bmp|pdf)$/) || lowerUrl.includes('/images/') || lowerUrl.includes('/thumbnails/')) {
    detectedType = 'image';
  } else {
    detectedType = 'audio';
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
    zoneId: typeof m.zoneId === 'string' ? m.zoneId : String(m.zone_id || m.organizationId || m.organization_id || 'global'),
    organizationId: typeof m.organizationId === 'string' ? m.organizationId : (typeof m.organization_id === 'string' ? m.organization_id : (typeof m.zoneId === 'string' ? m.zoneId : String(m.zone_id || ''))),
    subgroupId: typeof m.subgroupId === 'string' ? m.subgroupId : (typeof m.subgroup_id === 'string' ? m.subgroup_id : (typeof m.churchId === 'string' ? m.churchId : null)),
    churchId: typeof m.churchId === 'string' ? m.churchId : (typeof m.subgroupId === 'string' ? m.subgroupId : (typeof m.subgroup_id === 'string' ? m.subgroup_id : null)),
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

  try {
    const assetRows = await prisma.mediaAsset.findMany();
    const combined = assetRows.map((r) => normalizeAsset(r, 'media_assets'));
    combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    cachedMediaAssets = combined;
    lastMediaCacheTime = now;
    return combined;
  } catch (err: any) {
    console.warn('[media:cache] Retrying database query after connection drop...', err?.message || err);
    if (cachedMediaAssets && cachedMediaAssets.length > 0) {
      return cachedMediaAssets;
    }
    // Retry once
    const assetRows = await prisma.mediaAsset.findMany();
    const combined = assetRows.map((r) => normalizeAsset(r, 'media_assets'));
    combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    cachedMediaAssets = combined;
    lastMediaCacheTime = now;
    return combined;
  }
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

// GET /media - List media strictly scoped to the active organization / zone / church
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const { zoneId: requestedZoneId, organizationId: requestedOrgId, subgroupId: requestedSubgroupId, churchId: requestedChurchId, type, search, featured, isHqOnly, limit, page = '1' } = req.query;
    const allAssets = await loadAllMediaAssets();
    const tenant = req.tenant;
    
    // Determine the active target tenant (supports all HQ zones like zone-002, zone-orchestra, zone-director, zone-001, and regional zones)
    const activeZone = requestedZoneId || requestedOrgId || tenant?.effectiveZoneId || (tenant?.isHQAdmin ? 'zone-001' : undefined);
    const activeSubgroup = requestedSubgroupId || requestedChurchId || tenant?.effectiveChurchId;

    let data = allAssets;

    // Strict Tenant Isolation: HQ only sees HQ media, each zone/church only sees its own media
    if (activeZone && activeZone !== 'all') {
      const target = String(activeZone).toLowerCase().trim();
      const withoutHyphen = target.replace(/-/g, '');
      const withHyphen = target.includes('-') ? target : target.replace(/^zone(\d+)$/, 'zone-$1');

      data = data.filter((item) => {
        const itemZone = String(item.zoneId || (item as any).organizationId || (item as any).organization_id || '').toLowerCase().trim();
        const itemWithoutHyphen = itemZone.replace(/-/g, '');

        return (
          itemZone === target ||
          itemZone === withHyphen ||
          itemWithoutHyphen === withoutHyphen
        );
      });
    }

    if (activeSubgroup && activeSubgroup !== 'all') {
      const targetSg = String(activeSubgroup).trim();
      data = data.filter((item) => {
        const itemSg = String(item.subgroupId || item.churchId || '');
        return itemSg === targetSg;
      });
    }

    if (type && type !== 'all') {
      data = data.filter((item) => item.type === type);
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
    const rows = await prisma.category.findMany({ where: { type: 'MEDIA' } });
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
    res.status(500).json({ success: false, error: 'Failed to fetch categories' });
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

    const mediaType = (body.type ? String(body.type).toUpperCase() : 'AUDIO') as any;
    const orgId = body.organizationId || body.zoneId || (req.tenant?.isHQAdmin ? 'zone-001' : req.tenant?.effectiveZoneId || null);

    const rawData = {
      ...body,
      id,
      zoneId: orgId,
      createdAt: now,
      updatedAt: now,
    };

    const created = await prisma.mediaAsset.create({
      data: {
        id,
        title: body.title || 'Untitled Media',
        type: mediaType,
        folder: body.folder || 'audio',
        organizationId: orgId,
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
      if (existing.organizationId && existing.organizationId !== tenant?.effectiveZoneId) {
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
