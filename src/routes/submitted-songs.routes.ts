import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

// ─── Notification Helper ─────────────────────────────────────────────────────

async function createSubmissionNotification({
  targetUserId,
  targetAudience,
  title,
  message,
  type = 'info',
  category = 'song_submission',
  priority = 'normal',
  senderName = 'Ministry Review Team',
  senderId,
  submissionId,
  zoneId,
}: {
  targetUserId?: string | null;
  targetAudience?: string;
  title: string;
  message: string;
  type?: string;
  category?: string;
  priority?: string;
  senderName?: string;
  senderId?: string;
  submissionId: string;
  zoneId?: string;
}) {
  try {
    const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const rawData = {
      id, title, message, body: message, type, category, priority,
      target_audience: targetAudience || (targetUserId ? 'user' : 'all'),
      targetAudience: targetAudience || (targetUserId ? 'user' : 'all'),
      target_user_id: targetUserId || null,
      targetUserId: targetUserId || null,
      target_zone_id: zoneId || null,
      sender_id: senderId || null,
      sender_name: senderName,
      sentBy: senderName,
      actionUrl: '/pages/submit-song',
      action_url: '/pages/submit-song',
      submissionId,
      created_at: now, createdAt: now, sentAt: now, is_read: false,
    };

    const priorityEnum = (priority ? String(priority).toUpperCase() : 'NORMAL') as any;

    const record = await prisma.broadcastNotification.create({
      data: {
        id,
        title,
        body: message,
        message,
        type: type || 'info',
        category: category || 'song_submission',
        priority: priorityEnum,
        organizationId: zoneId || 'zone-001',
        senderId: senderId || null,
        actionUrl: '/pages/submit-song',
        createdAt: new Date(),
        rawData,
      },
    });
    broadcast('notifications', 'all', record);
  } catch (err) {
    console.error('[createSubmissionNotification]', err);
  }
}

// ─── Shape Helper ─────────────────────────────────────────────────────────────

function shapeSubmission(r: any) {
  const raw = (r.rawData && typeof r.rawData === 'object') ? (r.rawData as Record<string, any>) : {};

  const title = r.title || raw.songTitle || raw.title || 'Untitled Song';
  const writer = raw.writer || raw.composer || raw.artist || 'Unknown Composer';
  const artist = raw.artist || raw.leadSinger || writer;
  const leadSinger = raw.leadSinger || raw.lead_singer || '';
  const lyrics = raw.lyrics || '';
  const audioUrl = raw.audioUrl || raw.audio_url || raw.audioFile || null;
  const key = raw.key || raw.songKey || '';
  const tempo = raw.tempo || '';
  const solfas = raw.solfas || raw.solfa || '';
  const category = raw.category || 'General';
  const notes = raw.notes || '';
  const rejectNotes = raw.rejectNotes || raw.rejection_reason || '';
  const zoneName = raw.zoneName || raw.zone_name || '';
  const zoneId = r.zoneId || raw.zoneId || raw.zone_code || '';
  const submittedBy = r.submittedBy || raw.submittedByName || raw.userName || writer;
  const submittedByEmail = r.submittedByEmail || raw.submittedByEmail || raw.userEmail || '';
  const status = r.status || 'pending';
  const createdAt = r.createdAt || raw.createdAt || raw.created_at || new Date().toISOString();
  const conversation = Array.isArray(raw.conversation) ? raw.conversation : [];

  return {
    ...raw,
    id: String(r.id),
    userId: r.userId || raw.userId || null,
    title, writer, artist, leadSinger, lyrics, audioUrl, key, tempo,
    solfas, category, notes, rejectNotes, zoneName, zoneId, submittedBy,
    submittedByEmail, status, conversation, createdAt, rawData: raw,
  };
}

// ─── Tenant zone resolver ─────────────────────────────────────────────────────

/**
 * Resolves effective zone for a request.
 * Priority: tenant middleware → JWT auth.zoneId → query param.
 * Zone admins are ALWAYS scoped to their JWT zone — no override.
 */
function resolveEffectiveZone(req: any, auth: any): string | null {
  const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin';
  if (isHqAdmin) {
    // HQ Admins can scope down via scope switcher header or query param
    return req.tenant?.effectiveZoneId ?? null;
  }
  // Non-HQ: always lock to JWT zoneId (RLS-proof — doesn't depend on tenant middleware query)
  return auth.zoneId || req.tenant?.effectiveZoneId || null;
}

const HQ_ZONE_IDS = new Set([
  'zone-001', 'zone-002', 'zone-003', 'zone-004', 'zone-005',
  'loveworld-singers-hq', 'zone001', 'zone002', 'zone003', 'zone004', 'zone005',
  'hq', 'global', 'all',
]);

// ─── Routes ──────────────────────────────────────────────────────────────────

/** GET /submitted-songs — List submissions */
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const { status, mine } = req.query;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'super_admin';
    const isZoneAdmin = auth.role === 'zone_admin' || auth.role === 'zone_coordinator' || auth.role === 'coordinator' || auth.role === 'church_coordinator';
    const effectiveZoneId = resolveEffectiveZone(req, auth);

    let rows: any[];

    if (mine === 'true' || (!isHqAdmin && !isZoneAdmin)) {
      // Regular singer — own submissions only
      rows = await prisma.submittedSong.findMany({
        where: { userId: auth.userId },
        orderBy: { createdAt: 'desc' },
      });
    } else if (effectiveZoneId && !HQ_ZONE_IDS.has(effectiveZoneId.toLowerCase().trim())) {
      // Zone-scoped coordinator or HQ Admin inspecting a specific zone
      // Use case-insensitive zone matching via Prisma raw filtering on rawData
      const cleanZone = effectiveZoneId.toLowerCase().trim();
      const withoutHyphen = cleanZone.replace(/[\s\-_]/g, '');
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM submitted_songs
         WHERE lower(replace(replace(zone_id, '-', ''), ' ', '')) = $1
            OR lower(zone_id) = $2
            OR lower(replace(replace(raw_data->>'zoneId', '-', ''), ' ', '')) = $1
            OR lower(replace(replace(raw_data->>'zone_code', '-', ''), ' ', '')) = $1`,
        withoutHyphen,
        cleanZone,
      );
    } else {
      // HQ global view — all submissions
      rows = await prisma.submittedSong.findMany({ orderBy: { createdAt: 'desc' } });
    }

    let data = rows.map(shapeSubmission);
    if (status && status !== 'all') {
      data = data.filter((s) => s.status === status);
    }

    function getActivityTimestamp(s: any): number {
      const candidates = [s.lastActivityAt, s.updatedAt, s.createdAt, s.rawData?.lastActivityAt, s.rawData?.updatedAt, s.rawData?.createdAt];
      if (Array.isArray(s.conversation) && s.conversation.length > 0) {
        const last = s.conversation[s.conversation.length - 1];
        if (last?.timestamp) candidates.push(last.timestamp);
      }
      for (const c of candidates) {
        if (c) { const ms = new Date(c).getTime(); if (!isNaN(ms) && ms > 0) return ms; }
      }
      return 0;
    }

    data.sort((a, b) => getActivityTimestamp(b) - getActivityTimestamp(a));
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[submitted-songs:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load submitted songs' });
  }
});

/** GET /submitted-songs/mine */
router.get('/mine', requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.auth.userId;
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM submitted_songs
       WHERE user_id = $1
          OR raw_data->>'user_id' = $1
          OR raw_data->>'userId' = $1`,
      userId,
    );
    const data = rows.map(shapeSubmission)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[submitted-songs:mine]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch your submissions' });
  }
});

/** POST /submitted-songs — Create song submission */
router.post('/', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const userId = auth.userId;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const userProfile = await prisma.profile.findUnique({ where: { id: userId } });
    const rawProfile = (userProfile?.rawData && typeof userProfile.rawData === 'object')
      ? (userProfile.rawData as Record<string, any>) : {};

    const requestedZone = req.body.zoneId || req.body.zone_id;
    const effectiveZoneId = resolveEffectiveZone(req, auth);
    if (!req.tenant?.isHQAdmin && requestedZone && effectiveZoneId && requestedZone !== effectiveZoneId) {
      res.status(403).json({ success: false, error: 'Forbidden: Cannot create records outside your assigned zone.' });
      return;
    }

    const fullName = [userProfile?.firstName, userProfile?.lastName].filter(Boolean).join(' ')
      || (rawProfile.first_name ? `${rawProfile.first_name} ${rawProfile.last_name || ''}` : '')
      || auth.email;
    const userEmail = userProfile?.email || auth.email || '';
    const userZone = effectiveZoneId || auth.zoneId || rawProfile.zone_code || rawProfile.zoneId || 'general';
    const userZoneName = req.body.zoneName || userZone;

    const submissionRaw = {
      id, userId, user_id: userId,
      title: req.body.title?.trim() || 'Untitled Song',
      writer: req.body.writer?.trim() || fullName,
      artist: req.body.artist?.trim() || req.body.leadSinger?.trim() || fullName,
      leadSinger: req.body.leadSinger?.trim() || '',
      lyrics: req.body.lyrics?.trim() || '',
      key: req.body.key?.trim() || '',
      tempo: req.body.tempo?.trim() || '',
      solfas: req.body.solfas?.trim() || '',
      category: req.body.category || 'General',
      notes: req.body.notes?.trim() || '',
      audioUrl: req.body.audioUrl || req.body.audio_url || null,
      zoneId: userZone, zoneName: userZoneName,
      submittedBy: fullName, submittedByEmail: userEmail,
      status: 'pending', createdAt: now, updatedAt: now,
    };

    const inserted = await prisma.submittedSong.create({
      data: {
        id, userId,
        title: submissionRaw.title,
        status: 'PENDING',
        zoneId: userZone,
        submittedBy: fullName,
        submittedByEmail: userEmail,
        createdAt: new Date(),
        rawData: submissionRaw,
      },
    });

    res.status(201).json({ success: true, message: 'Song submitted successfully', data: shapeSubmission(inserted) });
  } catch (err: any) {
    console.error('[submitted-songs:create]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to submit song' });
  }
});

/** PATCH /submitted-songs/:id */
router.patch('/:id', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { status, notes, rejectNotes, title, lyrics, writer, leadSinger, key, audioUrl } = req.body;

    const existing = await prisma.submittedSong.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Submission not found' });

    const existingRaw = (existing.rawData as Record<string, any>) || {};
    const updatedRaw = {
      ...existingRaw,
      ...(title !== undefined ? { title: title.trim(), songTitle: title.trim() } : {}),
      ...(lyrics !== undefined ? { lyrics: lyrics.trim() } : {}),
      ...(writer !== undefined ? { writer: writer.trim(), composer: writer.trim() } : {}),
      ...(leadSinger !== undefined ? { leadSinger: leadSinger.trim() } : {}),
      ...(key !== undefined ? { key: key.trim() } : {}),
      ...(audioUrl !== undefined ? { audioUrl, audio_url: audioUrl } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(rejectNotes !== undefined ? { rejectNotes } : {}),
      ...(status !== undefined ? { status } : {}),
      updatedAt: new Date().toISOString(),
      reviewedBy: res.locals.auth.userId,
    };

    const updated = await prisma.submittedSong.update({
      where: { id },
      data: {
        title: title || existing.title,
        status: (status ? String(status).toUpperCase() : existing.status) as any,
        rawData: updatedRaw,
      },
    });

    res.json({ success: true, message: 'Submission updated', data: shapeSubmission(updated) });
  } catch (err) {
    console.error('[submitted-songs:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update submission' });
  }
});

/** POST /submitted-songs/:id/approve */
router.post('/:id/approve', requireAuth, requireTenantAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.submittedSong.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    const raw = (existing.rawData as Record<string, any>) || {};
    await prisma.submittedSong.update({
      where: { id },
      data: { status: 'APPROVED', rawData: { ...raw, status: 'approved', approvedAt: new Date().toISOString(), approvedBy: res.locals.auth.userId } },
    });

    const songTitle = existing.title || raw.title || 'Submitted Song';
    if (existing.userId) {
      await createSubmissionNotification({
        targetUserId: existing.userId,
        title: `Song Submission Approved! 🎉`,
        message: `Congratulations! Your song "${songTitle}" has been approved.`,
        type: 'success', category: 'song_submission', priority: 'high',
        senderName: res.locals.auth.name || 'HQ Admin', senderId: res.locals.auth.userId,
        submissionId: id, zoneId: existing.zoneId || undefined,
      });
    }
    res.json({ success: true, message: 'Song approved successfully' });
  } catch (err) {
    console.error('[submitted-songs:approve]', err);
    res.status(500).json({ success: false, error: 'Failed to approve song' });
  }
});

/** POST /submitted-songs/:id/reject */
router.post('/:id/reject', requireAuth, requireTenantAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { notes, reason } = req.body;
    const existing = await prisma.submittedSong.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    const raw = (existing.rawData as Record<string, any>) || {};
    const rejectNote = notes || reason || raw.rejectNotes;
    await prisma.submittedSong.update({
      where: { id },
      data: { status: 'REJECTED', rawData: { ...raw, status: 'rejected', rejectNotes: rejectNote, rejectedAt: new Date().toISOString(), rejectedBy: res.locals.auth.userId } },
    });

    const songTitle = existing.title || raw.title || 'Submitted Song';
    if (existing.userId) {
      await createSubmissionNotification({
        targetUserId: existing.userId,
        title: `Song Submission Update: "${songTitle}"`,
        message: `Feedback on your song "${songTitle}": ${rejectNote || 'Please check feedback notes.'}`,
        type: 'info', category: 'song_submission', priority: 'normal',
        senderName: res.locals.auth.name || 'HQ Admin', senderId: res.locals.auth.userId,
        submissionId: id, zoneId: existing.zoneId || undefined,
      });
    }
    res.json({ success: true, message: 'Song submission rejected' });
  } catch (err) {
    console.error('[submitted-songs:reject]', err);
    res.status(500).json({ success: false, error: 'Failed to reject song' });
  }
});

/** DELETE /submitted-songs/:id */
router.delete('/:id', requireAuth, requireTenantAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.submittedSong.delete({ where: { id } });
    res.json({ success: true, message: 'Song submission deleted' });
  } catch (err) {
    console.error('[submitted-songs:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete submission' });
  }
});

/** POST /submitted-songs/:id/reply */
router.post('/:id/reply', requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { message, senderName, replyTo } = req.body;
    const auth = res.locals.auth;
    if (!message?.trim()) return res.status(400).json({ success: false, error: 'Message cannot be empty' });

    const existing = await prisma.submittedSong.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

    const raw = (existing.rawData as Record<string, any>) || {};
    const conversation = Array.isArray(raw.conversation) ? [...raw.conversation] : [];
    const isUserSender = existing.userId === auth.userId;

    const newMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      sender: isUserSender ? 'user' : 'admin',
      senderId: auth.userId,
      senderName: senderName || auth.email || (isUserSender ? 'Singer' : 'Admin Reviewer'),
      message: message.trim(),
      replyTo: replyTo && typeof replyTo === 'object' ? {
        id: replyTo.id,
        text: String(replyTo.text || '').substring(0, 120),
        senderName: replyTo.senderName || 'Unknown',
      } : null,
      reactions: {},
      timestamp: new Date().toISOString(),
    };

    conversation.push(newMessage);
    const updatedRaw = {
      ...raw, conversation,
      ...(isUserSender ? { userReply: message.trim() } : { replyMessage: message.trim() }),
      lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    await prisma.submittedSong.update({ where: { id }, data: { rawData: updatedRaw } });

    const songTitle = existing.title || raw.title || 'Submitted Song';
    if (!isUserSender && existing.userId) {
      await createSubmissionNotification({
        targetUserId: existing.userId,
        title: `New Message on "${songTitle}"`,
        message: `${newMessage.senderName}: "${message.trim().substring(0, 100)}"`,
        type: 'info', category: 'song_submission', priority: 'high',
        senderName: newMessage.senderName, senderId: auth.userId,
        submissionId: id, zoneId: existing.zoneId || undefined,
      });
    } else if (isUserSender) {
      await createSubmissionNotification({
        targetAudience: 'admins',
        title: `Reply on Song: "${songTitle}"`,
        message: `${newMessage.senderName}: "${message.trim().substring(0, 100)}"`,
        type: 'info', category: 'song_submission', priority: 'normal',
        senderName: newMessage.senderName, senderId: auth.userId,
        submissionId: id, zoneId: existing.zoneId || undefined,
      });
    }

    res.json({ success: true, message: 'Message sent successfully', data: conversation, newMessage });
  } catch (err) {
    console.error('[submitted-songs:reply]', err);
    res.status(500).json({ success: false, error: 'Failed to post reply' });
  }
});

/** PATCH /submitted-songs/:id/conversation/:messageId — Edit message */
router.patch('/:id/conversation/:messageId', requireAuth, async (req: any, res) => {
  try {
    const { id, messageId } = req.params;
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, error: 'Updated message cannot be empty' });

    const existing = await prisma.submittedSong.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Submission not found' });

    const raw = (existing.rawData as Record<string, any>) || {};
    const conversation = Array.isArray(raw.conversation) ? [...raw.conversation] : [];
    const msgIdx = conversation.findIndex((m: any) => m.id === messageId);
    if (msgIdx === -1) return res.status(404).json({ success: false, error: 'Message not found' });

    conversation[msgIdx] = { ...conversation[msgIdx], message: message.trim(), isEdited: true, editedAt: new Date().toISOString() };
    await prisma.submittedSong.update({ where: { id }, data: { rawData: { ...raw, conversation, updatedAt: new Date().toISOString() } } });
    res.json({ success: true, message: 'Message updated', data: conversation });
  } catch (err) {
    console.error('[submitted-songs:edit-message]', err);
    res.status(500).json({ success: false, error: 'Failed to edit message' });
  }
});

/** DELETE /submitted-songs/:id/conversation/:messageId */
router.delete('/:id/conversation/:messageId', requireAuth, async (req, res) => {
  try {
    const { id, messageId } = req.params;
    const existing = await prisma.submittedSong.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Submission not found' });

    const raw = (existing.rawData as Record<string, any>) || {};
    const conversation = (Array.isArray(raw.conversation) ? raw.conversation : []).filter((m: any) => m.id !== messageId);
    await prisma.submittedSong.update({ where: { id }, data: { rawData: { ...raw, conversation, updatedAt: new Date().toISOString() } } });
    res.json({ success: true, message: 'Message deleted', data: conversation });
  } catch (err) {
    console.error('[submitted-songs:delete-message]', err);
    res.status(500).json({ success: false, error: 'Failed to delete message' });
  }
});

/** POST /submitted-songs/:id/conversation/:messageId/react */
router.post('/:id/conversation/:messageId/react', requireAuth, async (req: any, res) => {
  try {
    const { id, messageId } = req.params;
    const { emoji } = req.body;
    const auth = res.locals.auth;
    if (!emoji) return res.status(400).json({ success: false, error: 'Emoji is required' });

    const existing = await prisma.submittedSong.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ success: false, error: 'Submission not found' });

    const raw = (existing.rawData as Record<string, any>) || {};
    const conversation = Array.isArray(raw.conversation) ? [...raw.conversation] : [];
    const msgIdx = conversation.findIndex((m: any) => m.id === messageId);
    if (msgIdx === -1) return res.status(404).json({ success: false, error: 'Message not found' });

    const msg = conversation[msgIdx];
    const reactions = { ...(msg.reactions || {}) };
    const currentUsers: string[] = Array.isArray(reactions[emoji]) ? [...reactions[emoji]] : [];
    const userIdentifier = auth.userId || auth.email || 'user';

    if (currentUsers.includes(userIdentifier)) {
      reactions[emoji] = currentUsers.filter((u: string) => u !== userIdentifier);
      if (reactions[emoji].length === 0) delete reactions[emoji];
    } else {
      reactions[emoji] = [...currentUsers, userIdentifier];
    }

    conversation[msgIdx] = { ...msg, reactions };
    await prisma.submittedSong.update({ where: { id }, data: { rawData: { ...raw, conversation, updatedAt: new Date().toISOString() } } });
    res.json({ success: true, data: conversation });
  } catch (err) {
    console.error('[submitted-songs:react]', err);
    res.status(500).json({ success: false, error: 'Failed to react' });
  }
});

export default router;
