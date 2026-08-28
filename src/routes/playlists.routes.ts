import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import { asStringArray, mergeRawRow } from '../lib/rawRow';

const router = Router();

router.get('/me', requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const rows = await prisma.playlist.findMany({ where: { userId } });
    const data = rows.map((row) => {
      const merged = mergeRawRow(row);
      const songIds = asStringArray(merged.songIds ?? merged.songs ?? row.songIds);
      return { id: row.id, userId: row.userId ?? userId, name: (merged.name as string) || (merged.title as string) || row.title || 'Playlist', title: row.title || (merged.title as string) || 'Playlist', songs: songIds, songIds, isPublic: row.isPublic ?? false, rawData: row.rawData };
    });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[playlists/me]', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const { name, title, songIds = [], isPublic = false, description } = req.body;
    const playlistTitle = (title || name || 'New Playlist').trim();
    const requestedId = typeof req.body.id === 'string' ? req.body.id : '';
    const playlistId = requestedId.startsWith(`${userId}_`) ? requestedId : `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newSongIds = Array.isArray(songIds) ? songIds : [];
    const created = await prisma.playlist.create({
      data: { id: playlistId, title: playlistTitle, userId, songIds: newSongIds, isPublic: Boolean(isPublic), rawData: { name: playlistTitle, title: playlistTitle, description: description || '', createdBy: userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } },
    });
    res.json({ success: true, data: { id: created.id, name: playlistTitle, title: playlistTitle, userId, songIds: newSongIds, songs: newSongIds, isPublic: created.isPublic } });
  } catch (err) {
    console.error('[playlists:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create playlist' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const row = await prisma.playlist.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (row.userId !== (res.locals.auth.userId as string) && !row.isPublic) return res.status(403).json({ success: false, error: 'Forbidden' });
    const merged = mergeRawRow(row);
    const songIds = asStringArray(merged.songIds ?? merged.songs ?? row.songIds);
    let resolvedSongs: any[] = [];
    if (songIds.length > 0) {
      const hqList = await prisma.song.findMany({ where: { id: { in: songIds } } }).catch(() => []);
      const songMap = new Map<string, any>();
      hqList.forEach((s) => {
        if (!songMap.has(s.id)) {
          const m = mergeRawRow(s);
          const raw = (s.rawData && typeof s.rawData === 'object') ? (s.rawData as any) : {};
          songMap.set(s.id, { ...m, id: s.id, title: s.title || raw.title || 'Untitled Song', audioFile: s.audioFile || raw.audioFile || raw.audioUrl || '', audioUrls: (s as any).audioUrls || raw.audioUrls || {}, lyrics: (s as any).lyrics || raw.lyrics || '', leadSinger: (s as any).leadSinger || raw.leadSinger || 'Loveworld Singers', writer: (s as any).writer || raw.writer || '', key: s.key || raw.key || '', tempo: s.tempo || raw.tempo || '' });
        }
      });
      resolvedSongs = songIds.map((sid) => songMap.get(sid)).filter(Boolean);
    }
    res.json({ success: true, data: { id: row.id, userId: row.userId, name: (merged.name as string) || row.title || 'Playlist', title: row.title || 'Playlist', songIds, songs: resolvedSongs, isPublic: row.isPublic ?? true, rawData: row.rawData } });
  } catch (err) {
    console.error('[playlists/:id:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch playlist' });
  }
});

router.post('/:id/songs', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { songId, songIds } = req.body;
    const toAdd: string[] = songIds ? asStringArray(songIds) : songId ? [String(songId)] : [];
    if (toAdd.length === 0) return res.status(400).json({ success: false, error: 'songId or songIds required' });
    const existing = await prisma.playlist.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (existing.userId !== (res.locals.auth.userId as string)) return res.status(403).json({ success: false, error: 'Forbidden' });
    const merged = mergeRawRow(existing);
    const currentList = asStringArray(merged.songIds ?? merged.songs ?? existing.songIds);
    const updatedIds = Array.from(new Set([...currentList, ...toAdd]));
    const raw = (existing.rawData && typeof existing.rawData === 'object') ? { ...(existing.rawData as any) } : {};
    raw.songIds = updatedIds; raw.updatedAt = new Date().toISOString();
    const updated = await prisma.playlist.update({ where: { id }, data: { songIds: updatedIds, rawData: raw } });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[playlists/:id/songs:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to add song to playlist' });
  }
});

router.delete('/:id/songs/:songId', requireAuth, async (req, res) => {
  try {
    const { id, songId } = req.params;
    const existing = await prisma.playlist.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (existing.userId !== (res.locals.auth.userId as string)) return res.status(403).json({ success: false, error: 'Forbidden' });
    const merged = mergeRawRow(existing);
    const updatedIds = asStringArray(merged.songIds ?? merged.songs ?? existing.songIds).filter((s) => s !== songId);
    const raw = (existing.rawData && typeof existing.rawData === 'object') ? { ...(existing.rawData as any) } : {};
    raw.songIds = updatedIds; raw.updatedAt = new Date().toISOString();
    const updated = await prisma.playlist.update({ where: { id }, data: { songIds: updatedIds, rawData: raw } });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[playlists/:id/songs:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to remove song from playlist' });
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = res.locals.auth.userId as string;
    const existing = await prisma.playlist.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (existing.userId !== userId) return res.status(403).json({ success: false, error: 'Forbidden' });
    const body = req.body || {};
    const raw = (existing.rawData && typeof existing.rawData === 'object') ? { ...(existing.rawData as any) } : {};
    const title = body.title ?? body.name;
    if (title !== undefined) raw.title = title;
    if (body.description !== undefined) raw.description = body.description;
    raw.updatedAt = new Date().toISOString();
    const updated = await prisma.playlist.update({ where: { id }, data: { ...(title !== undefined ? { title: String(title).trim() } : {}), ...(body.isPublic !== undefined ? { isPublic: Boolean(body.isPublic) } : {}), rawData: raw } });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[playlists/:id:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update playlist' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = res.locals.auth.userId as string;
    const existing = await prisma.playlist.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Playlist not found' });
    if (existing.userId !== userId) return res.status(403).json({ success: false, error: 'Forbidden' });
    await prisma.playlist.delete({ where: { id } });
    res.json({ success: true, message: 'Playlist deleted' });
  } catch (err) {
    console.error('[playlists/:id:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete playlist' });
  }
});

export default router;
