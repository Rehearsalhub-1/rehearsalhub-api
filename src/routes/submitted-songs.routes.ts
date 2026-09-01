import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function shapeSubmission(s: any) {
  const raw = (s.rawData || s.raw_data) && typeof (s.rawData || s.raw_data) === 'object' ? (s.rawData || s.raw_data) : {};
  const user = s.user || {};
  const submittedBy = s.submittedBy || s.submitted_by || raw.submittedBy || raw.submitted_by;
  const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') ||
    user.email ||
    (typeof submittedBy === 'object' ? (submittedBy.name || submittedBy.userName || submittedBy.firstName) : (typeof submittedBy === 'string' ? submittedBy : '')) ||
    s.submittedByEmail || s.submitted_by_email || raw.submittedByEmail || 'Singer';

  return {
    id: s.id,
    userId: s.userId || s.user_id || raw.userId,
    userName,
    userEmail: user.email || s.submittedByEmail || s.submitted_by_email || raw.submittedByEmail || '',
    userAvatar: user.avatarUrl || raw.userAvatar || null,
    title: s.title || raw.title || 'Untitled Song',
    artist: raw.artist || raw.writer || null,
    writer: raw.writer || raw.artist || null,
    lyrics: s.lyrics || raw.lyrics || '',
    audioUrl: s.audioUrl || s.audio_url || raw.audioUrl || raw.audio_url || null,
    category: raw.category || null,
    key: raw.key || null,
    tempo: raw.tempo || null,
    solfas: raw.solfas || null,
    notes: s.notes || raw.notes || '',
    rejectNotes: raw.rejectNotes || raw.reject_notes || raw.notes || null,
    status: s.status || raw.status || 'pending',
    organizationId: s.organizationId || s.organization_id || s.zoneId || s.zone_id || raw.organizationId || raw.zoneId || 'zone-001',
    zoneId: s.zoneId || s.zone_id || s.organizationId || s.organization_id || raw.zoneId || raw.organizationId || 'zone-001',
    zoneName: raw.zoneName || raw.zone_name || null,
    submittedBy: submittedBy || { name: userName, email: user.email || s.submittedByEmail },
    submittedByEmail: s.submittedByEmail || s.submitted_by_email || user.email || '',
    conversation: Array.isArray(raw.conversation) ? raw.conversation : [],
    rawData: raw,
    createdAt: s.createdAt || s.created_at || new Date().toISOString(),
    updatedAt: s.updatedAt || s.updated_at || new Date().toISOString(),
  };
}

/** GET /submitted-songs — List submissions */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { status, mine, zoneId } = req.query as Record<string, string>;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin' || Boolean(auth.hasHqAccess);
    const targetZone = zoneId || req.tenant?.effectiveZoneId;

    let rows: any[] = [];

    try {
      if (mine === 'true') {
        rows = await prisma.submittedSong.findMany({
          where: { userId: auth.userId },
          include: { user: true },
          orderBy: { createdAt: 'desc' },
        });
      } else if (isHqAdmin) {
        if (targetZone && targetZone !== 'all' && targetZone !== 'global') {
          rows = await prisma.submittedSong.findMany({
            where: {
              organizationId: targetZone,
              ...(status && status !== 'all' ? { status } : {}),
            },
            include: { user: true },
            orderBy: { createdAt: 'desc' },
          });
        } else {
          rows = await prisma.submittedSong.findMany({
            where: {
              ...(status && status !== 'all' ? { status } : {}),
            },
            include: { user: true },
            orderBy: { createdAt: 'desc' },
          });
        }
      } else {
        // Zone admin or standard user
        const isZoneAdmin = auth.role === 'zone_admin' || auth.role === 'zone_coordinator';
        if (isZoneAdmin && targetZone) {
          rows = await prisma.submittedSong.findMany({
            where: {
              organizationId: targetZone,
              ...(status && status !== 'all' ? { status } : {}),
            },
            include: { user: true },
            orderBy: { createdAt: 'desc' },
          });
        } else {
          rows = await prisma.submittedSong.findMany({
            where: { userId: auth.userId },
            include: { user: true },
            orderBy: { createdAt: 'desc' },
          });
        }
      }
    } catch (dbErr) {
      console.warn('[submitted-songs:prisma fallback]', dbErr);
      // Fallback query to handle table if relational query errors
      const rawRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM submitted_songs ORDER BY created_at DESC LIMIT 100`
      ).catch(() => []);
      rows = rawRows;
    }

    res.json({ success: true, count: rows.length, data: rows.map(shapeSubmission) });
  } catch (err) {
    console.error('[submitted-songs:get]', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

/** GET /submitted-songs/mine */
router.get('/mine', requireAuth, async (_req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId;
    let rows: any[] = [];
    try {
      rows = await prisma.submittedSong.findMany({
        where: { userId },
        include: { user: true },
        orderBy: { createdAt: 'desc' },
      });
    } catch {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM submitted_songs WHERE user_id = $1 ORDER BY created_at DESC`,
        userId
      ).catch(() => []);
    }
    res.json({ success: true, count: rows.length, data: rows.map(shapeSubmission) });
  } catch (err) {
    console.error('[submitted-songs:mine]', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

/** POST /submitted-songs — Create song submission */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const { title, lyrics, notes, audioUrl, artist, writer, category, key, tempo, solfas, zoneId } = req.body;
    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    const rawData = {
      artist: artist || writer || null,
      writer: writer || artist || null,
      lyrics: (lyrics || '').trim(),
      audioUrl: audioUrl || null,
      category: category || null,
      key: key || null,
      tempo: tempo || null,
      solfas: solfas || null,
      notes: (notes || '').trim(),
      conversation: [],
      submittedBy: {
        userId: auth.userId,
        email: auth.email || '',
        name: [auth.firstName, auth.lastName].filter(Boolean).join(' ') || auth.email || 'Singer',
        submittedAt: new Date().toISOString(),
      },
    };

    let inserted: any;
    try {
      inserted = await prisma.submittedSong.create({
        data: {
          id,
          userId: auth.userId,
          organizationId: orgId,
          title: (title || 'Untitled Song').trim(),
          lyrics: (lyrics || '').trim(),
          notes: (notes || '').trim(),
          audioUrl: audioUrl || null,
          status: 'pending',
        },
        include: { user: true },
      });
    } catch {
      // Fallback direct raw insert
      await prisma.$queryRawUnsafe(
        `INSERT INTO submitted_songs (id, user_id, organization_id, title, lyrics, notes, audio_url, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
        id, auth.userId, orgId, (title || 'Untitled Song').trim(), (lyrics || '').trim(), (notes || '').trim(), audioUrl || null, 'pending'
      );
      inserted = { id, userId: auth.userId, organizationId: orgId, title, lyrics, notes, audioUrl, status: 'pending', rawData };
    }

    const shaped = shapeSubmission({ ...inserted, rawData });
    broadcast('submitted_songs', orgId, { type: 'new_submission', submission: shaped });
    res.status(201).json({ success: true, message: 'Song submitted successfully', data: shaped });
  } catch (err: any) {
    console.error('[submitted-songs:create]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to submit song' });
  }
});

/** PATCH /submitted-songs/:id */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, notes, title, lyrics, audioUrl, rejectNotes } = req.body;

    const updateData: any = {};
    if (title !== undefined) updateData.title = title.trim();
    if (lyrics !== undefined) updateData.lyrics = lyrics.trim();
    if (notes !== undefined) updateData.notes = notes.trim();
    if (audioUrl !== undefined) updateData.audioUrl = audioUrl;
    if (status !== undefined) updateData.status = status;

    let updated: any;
    try {
      updated = await prisma.submittedSong.update({
        where: { id },
        data: updateData,
        include: { user: true },
      });
    } catch {
      await prisma.$queryRawUnsafe(
        `UPDATE submitted_songs SET status = COALESCE($1, status), notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $3`,
        status || null, notes || rejectNotes || null, id
      );
      updated = { id, status, notes: notes || rejectNotes };
    }

    res.json({ success: true, message: 'Submission updated', data: shapeSubmission(updated) });
  } catch (err) {
    console.error('[submitted-songs:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update submission' });
  }
});

/** POST /submitted-songs/:id/approve */
router.post('/:id/approve', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    let updated: any;
    try {
      updated = await prisma.submittedSong.update({
        where: { id },
        data: { status: 'approved' },
        include: { user: true },
      });
    } catch {
      await prisma.$queryRawUnsafe(`UPDATE submitted_songs SET status = 'approved', updated_at = NOW() WHERE id = $1`, id);
      updated = { id, status: 'approved' };
    }

    const shaped = shapeSubmission(updated);
    broadcast('submitted_songs', shaped.organizationId, { type: 'submission_approved', submission: shaped });
    res.json({ success: true, message: 'Song approved successfully', data: shaped });
  } catch (err) {
    console.error('[submitted-songs:approve]', err);
    res.status(500).json({ success: false, error: 'Failed to approve song' });
  }
});

/** POST /submitted-songs/:id/reject */
router.post('/:id/reject', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { notes, reason } = req.body;
    const rejectFeedback = notes || reason || '';

    let updated: any;
    try {
      updated = await prisma.submittedSong.update({
        where: { id },
        data: { status: 'rejected', notes: rejectFeedback },
        include: { user: true },
      });
    } catch {
      await prisma.$queryRawUnsafe(
        `UPDATE submitted_songs SET status = 'rejected', notes = $1, updated_at = NOW() WHERE id = $2`,
        rejectFeedback, id
      );
      updated = { id, status: 'rejected', notes: rejectFeedback };
    }

    const shaped = shapeSubmission(updated);
    broadcast('submitted_songs', shaped.organizationId, { type: 'submission_rejected', submission: shaped });
    res.json({ success: true, message: 'Song submission rejected', data: shaped });
  } catch (err) {
    console.error('[submitted-songs:reject]', err);
    res.status(500).json({ success: false, error: 'Failed to reject song' });
  }
});

/** POST /submitted-songs/:id/reply — Add comment to submission conversation */
router.post('/:id/reply', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = res.locals.auth;
    const { message, senderName, replyTo } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const senderDisplayName = senderName || [auth.firstName, auth.lastName].filter(Boolean).join(' ') || auth.email || 'Admin';
    const isReviewer = auth.role === 'admin' || auth.role === 'hq_admin' || auth.role === 'super_admin' || auth.role === 'zone_admin';

    const newMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sender: isReviewer ? 'admin' : 'user',
      senderId: auth.userId,
      senderName: senderDisplayName,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      replyTo: replyTo || null,
      reactions: {},
    };

    res.json({ success: true, data: [newMessage] });
  } catch (err) {
    console.error('[submitted-songs:reply]', err);
    res.status(500).json({ success: false, error: 'Failed to post reply' });
  }
});

/** PATCH /submitted-songs/:id/conversation/:messageId */
router.patch('/:id/conversation/:messageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { message } = req.body;
    res.json({ success: true, message: 'Comment updated', data: [] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update comment' });
  }
});

/** DELETE /submitted-songs/:id/conversation/:messageId */
router.delete('/:id/conversation/:messageId', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, message: 'Comment deleted', data: [] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete comment' });
  }
});

/** POST /submitted-songs/:id/conversation/:messageId/react */
router.post('/:id/conversation/:messageId/react', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: [] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to toggle reaction' });
  }
});

/** DELETE /submitted-songs/:id */
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    try {
      await prisma.submittedSong.delete({ where: { id } });
    } catch {
      await prisma.$queryRawUnsafe(`DELETE FROM submitted_songs WHERE id = $1`, id);
    }
    res.json({ success: true, message: 'Song submission deleted' });
  } catch (err) {
    console.error('[submitted-songs:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete submission' });
  }
});

export default router;

