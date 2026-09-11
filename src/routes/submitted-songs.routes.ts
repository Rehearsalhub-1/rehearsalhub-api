import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';
import { sendExpoPushToUsers } from './notifications.routes';

const router = Router();

function shapeSubmission(s: any, meta?: any) {
  const isPending = (s.status || '').toLowerCase() === 'pending';
  const isApproved = (s.status || '').toLowerCase() === 'approved';
  const isRejected = (s.status || '').toLowerCase() === 'rejected';
  const submitter = s.roleAssignments?.find((r: any) => r.role === 'SUBMITTER' || r.role === 'LEAD_SINGER');
  const user = submitter?.user || {};
  const firstName = user.firstName || user.first_name || '';
  const lastName = user.lastName || user.last_name || '';
  const userFullName = [firstName, lastName].filter(Boolean).join(' ') || user.name || user.email || s.writer || 'Member';
  const userEmail = user.email || '';
  const userAvatar = user.avatarUrl || user.profile_image_url || null;

  return {
    id: s.id,
    userId: submitter?.userId || s.groupId || null,
    userName: userFullName,
    userEmail: userEmail,
    userAvatar: userAvatar,
    title: s.title || 'Untitled Song',
    artist: s.writer || userFullName,
    writer: s.writer || userFullName,
    lyrics: s.lyrics || '',
    audioUrl: s.audioFile || null,
    audioFile: s.audioFile || null,
    category: s.category || 'Submitted Songs',
    key: s.key || null,
    tempo: s.tempo || null,
    solfas: s.solfas || null,
    leadSinger: s.leadSinger || userFullName,
    conductor: s.conductor || null,
    notes: s.notes || meta?.notes || '',
    rejectNotes: meta?.rejectNotes || meta?.reviewNotes || null,
    reviewNotes: meta?.reviewNotes || meta?.rejectNotes || null,
    conversation: Array.isArray(meta?.conversation) ? meta.conversation : [],
    status: isApproved ? 'approved' : (isRejected ? 'rejected' : 'pending'),
    organizationId: s.organizationId || 'zone-001',
    zoneId: s.organizationId || 'zone-001',
    zoneName: s.organization?.name || s.organizationId || null,
    submittedBy: {
      id: submitter?.userId || null,
      name: userFullName,
      userName: userFullName,
      email: userEmail,
      avatarUrl: userAvatar,
    },
    submittedByEmail: userEmail,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function getMetasForSongIds(songIds: string[]) {
  if (!songIds.length) return new Map<string, any>();
  const keys = songIds.map(id => `submitted_song_meta_${id}`);
  const rows = await prisma.setting.findMany({
    where: { key: { in: keys } },
  });
  const map = new Map<string, any>();
  for (const r of rows) {
    map.set(r.key, r.value);
  }
  return map;
}

/** GET /submitted-songs — List submissions */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { status, zoneId } = req.query as Record<string, string>;
    const targetZone = zoneId || req.tenant?.effectiveZoneId;

    const where: any = {
      OR: [
        { category: 'Submitted Songs' },
        { status: { in: ['pending', 'approved', 'rejected'] } },
      ],
    };

    if (status && status !== 'all') {
      where.status = status.toLowerCase();
    }

    if (targetZone && targetZone !== 'all' && targetZone !== 'global') {
      where.organizationId = targetZone;
    }

    const songs = await prisma.song.findMany({
      where,
      include: { organization: true, roleAssignments: { include: { user: true } } },
      orderBy: { createdAt: 'desc' },
      take: 250,
    });

    const metas = await getMetasForSongIds(songs.map(s => s.id));
    const shaped = songs.map(s => shapeSubmission(s, metas.get(`submitted_song_meta_${s.id}`)));

    res.json({ success: true, count: shaped.length, data: shaped });
  } catch (err) {
    console.error('[submitted-songs:get]', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

/** GET /submitted-songs/mine */
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const userId = auth?.userId;
    if (!userId) {
      return res.json({ success: true, count: 0, data: [] });
    }

    const whereConditions: any[] = [{ groupId: userId }];
    if (auth.firstName && auth.firstName.trim().length > 1) {
      whereConditions.push({
        writer: { contains: auth.firstName.trim(), mode: 'insensitive' },
      });
      whereConditions.push({
        leadSinger: { contains: auth.firstName.trim(), mode: 'insensitive' },
      });
    }

    const songs = await prisma.song.findMany({
      where: {
        OR: [
          { roleAssignments: { some: { userId } } },
          {
            category: 'Submitted Songs',
            OR: whereConditions,
          },
        ],
      },
      include: { organization: true, roleAssignments: { include: { user: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const metas = await getMetasForSongIds(songs.map(s => s.id));
    const shaped = songs.map(s => shapeSubmission(s, metas.get(`submitted_song_meta_${s.id}`)));

    res.json({ success: true, count: shaped.length, data: shaped });
  } catch (err) {
    console.error('[submitted-songs:mine]', err);
    res.json({ success: true, count: 0, data: [] });
  }
});

/** GET /submitted-songs/:id — Single submission */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const song = await prisma.song.findUnique({
      where: { id },
      include: { organization: true, roleAssignments: { include: { user: true } } },
    });
    if (!song) return res.status(404).json({ success: false, error: 'Submission not found' });

    const metaRow = await prisma.setting.findUnique({ where: { key: `submitted_song_meta_${id}` } });
    const formatted = shapeSubmission(song, metaRow?.value);
    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[submitted-songs:getById]', err);
    res.status(500).json({ success: false, error: 'Failed to get submission' });
  }
});

/** POST /submitted-songs — Create song submission */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const { title, lyrics, notes, audioUrl, artist, writer, leadSinger, category, key, tempo, solfas, zoneId } = req.body;
    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    if (orgId) {
      try {
        await prisma.organization.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
      } catch {}
    }

    const created = await prisma.song.create({
      data: {
        id,
        title: title || 'Untitled Submitted Song',
        writer: writer || artist || auth.firstName || 'Member',
        leadSinger: leadSinger || null,
        key: key || null,
        tempo: tempo || null,
        lyrics: lyrics || null,
        solfas: solfas || null,
        category: category || 'Submitted Songs',
        audioFile: audioUrl || null,
        status: 'pending',
        organizationId: orgId,
        groupId: null,
      },
      include: { organization: true },
    });

    if (auth.userId) {
      try {
        await prisma.songRoleAssignment.create({
          data: {
            songId: id,
            userId: auth.userId,
            role: 'SUBMITTER',
          },
        });
      } catch (roleErr) {
        console.warn('[submitted-songs:role]', roleErr);
      }
    }

    if (notes) {
      await prisma.setting.upsert({
        where: { key: `submitted_song_meta_${id}` },
        create: { key: `submitted_song_meta_${id}`, value: { notes, conversation: [] } },
        update: { value: { notes, conversation: [] } },
      }).catch(() => {});
    }

    const formatted = shapeSubmission(
      { ...created, roleAssignments: auth.userId ? [{ userId: auth.userId, role: 'SUBMITTER' }] : [] },
      { notes, conversation: [] }
    );
    broadcast('submitted_song', id, formatted);
    res.json({ success: true, data: formatted });
  } catch (err: any) {
    console.error('[submitted-songs:post]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to submit song' });
  }
});

/** POST /submitted-songs/:id/reply — Send coordinator or singer reply */
router.post('/:id/reply', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message, senderName, replyTo } = req.body || {};
    const auth = res.locals.auth;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: 'Message text is required' });
    }

    const song = await prisma.song.findUnique({
      where: { id },
      include: { organization: true, roleAssignments: { include: { user: true } } },
    });

    if (!song) {
      return res.status(404).json({ success: false, error: 'Song submission not found' });
    }

    const r = (auth?.role || '').toLowerCase();
    const isAdmin = r.includes('admin') || r.includes('coord') || r.includes('owner') || r.includes('leader');
    const sender = isAdmin ? 'admin' : 'user';

    const defaultName = [auth.firstName, auth.lastName].filter(Boolean).join(' ') ||
      auth.name ||
      (isAdmin ? 'Coordinator' : 'Singer');
    const resolvedSenderName = senderName?.trim() || defaultName;

    const newMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender,
      senderId: auth.userId,
      senderName: resolvedSenderName,
      message: String(message).trim(),
      timestamp: new Date().toISOString(),
      replyTo: replyTo || null,
    };

    const metaKey = `submitted_song_meta_${id}`;
    const metaRow = await prisma.setting.findUnique({ where: { key: metaKey } });
    const currentMeta = (metaRow?.value as any) || {};
    const currentConversation = Array.isArray(currentMeta.conversation) ? currentMeta.conversation : [];
    const updatedConversation = [...currentConversation, newMessage];
    currentMeta.conversation = updatedConversation;

    await prisma.setting.upsert({
      where: { key: metaKey },
      create: { key: metaKey, value: currentMeta },
      update: { value: currentMeta },
    });

    const formatted = shapeSubmission(song, currentMeta);
    broadcast('submitted_song', id, formatted);

    // Notify the submitter if sent by an admin/coordinator
    const submitterAssignment = song.roleAssignments?.find((ra: any) => ra.role === 'SUBMITTER' || ra.role === 'LEAD_SINGER');
    const submitterUserId = submitterAssignment?.userId;

    if (isAdmin && submitterUserId && submitterUserId !== auth.userId) {
      try {
        const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const notifTitle = 'Feedback on Submitted Song';
        const notifBody = `${resolvedSenderName}: "${newMessage.message.slice(0, 100)}"`;

        const notif = await prisma.notification.create({
          data: {
            id: notifId,
            title: notifTitle,
            body: notifBody,
            type: 'info',
            category: 'rehearsal',
            priority: 'normal',
            organizationId: song.organizationId || 'zone-001',
            senderId: auth.userId,
          },
        });

        await prisma.notificationDelivery.create({
          data: {
            notificationId: notifId,
            userId: submitterUserId,
            isRead: false,
          },
        });

        broadcast('notifications', submitterUserId, notif);

        sendExpoPushToUsers([submitterUserId], {
          title: notifTitle,
          body: notifBody,
          data: {
            notificationId: notifId,
            category: 'rehearsal',
            songId: id,
          },
        }).catch(err => console.warn('[submitted-songs:reply:push]', err));
      } catch (notifErr) {
        console.warn('[submitted-songs:reply:notif]', notifErr);
      }
    }

    res.json({ success: true, data: formatted, message: newMessage });
  } catch (err: any) {
    console.error('[submitted-songs:reply]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to send reply' });
  }
});

/** PATCH /submitted-songs/:id/approve */
router.patch('/:id/approve', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = res.locals.auth;
    const updated = await prisma.song.update({
      where: { id },
      data: { status: 'approved' },
      include: {
        organization: true,
        roleAssignments: { include: { user: true } },
      },
    });

    const metaRow = await prisma.setting.findUnique({ where: { key: `submitted_song_meta_${id}` } });
    const formatted = shapeSubmission(updated, metaRow?.value);
    broadcast('submitted_song', id, formatted);

    // Notify submitter privately
    const submitterAssignment = updated.roleAssignments?.find((r) => r.role === 'SUBMITTER' || r.role === 'LEAD_SINGER');
    const submitterUserId = submitterAssignment?.userId;

    if (submitterUserId) {
      try {
        const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const notifTitle = 'Song Approved';
        const notifBody = `Your song "${updated.title}" has been approved for rehearsals!`;

        const notif = await prisma.notification.create({
          data: {
            id: notifId,
            title: notifTitle,
            body: notifBody,
            type: 'success',
            category: 'rehearsal',
            priority: 'high',
            organizationId: updated.organizationId || 'zone-001',
            senderId: auth.userId || auth.id,
          },
        });

        await prisma.notificationDelivery.create({
          data: {
            notificationId: notifId,
            userId: submitterUserId,
            isRead: false,
          },
        });

        broadcast('notifications', submitterUserId, notif);

        sendExpoPushToUsers([submitterUserId], {
          title: notifTitle,
          body: notifBody,
          data: {
            notificationId: notifId,
            category: 'rehearsal',
            songId: id,
          },
        }).catch((err) => console.warn('[submitted-songs:approve:push]', err));
      } catch (notifErr) {
        console.warn('[submitted-songs:approve:notif]', notifErr);
      }
    }

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[submitted-songs:approve]', err);
    res.status(500).json({ success: false, error: 'Failed to approve song' });
  }
});

/** PATCH /submitted-songs/:id/reject */
router.patch('/:id/reject', requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const auth = res.locals.auth;
    const { notes, reason } = req.body || {};
    const rejectReason = (notes || reason || '').trim();

    const updated = await prisma.song.update({
      where: { id },
      data: { status: 'rejected' },
      include: {
        organization: true,
        roleAssignments: { include: { user: true } },
      },
    });

    const metaKey = `submitted_song_meta_${id}`;
    const metaRow = await prisma.setting.findUnique({ where: { key: metaKey } });
    const currentMeta = (metaRow?.value as any) || {};
    if (rejectReason) {
      currentMeta.rejectNotes = rejectReason;
      currentMeta.reviewNotes = rejectReason;
    }

    await prisma.setting.upsert({
      where: { key: metaKey },
      create: { key: metaKey, value: currentMeta },
      update: { value: currentMeta },
    });

    const formatted = shapeSubmission(updated, currentMeta);
    broadcast('submitted_song', id, formatted);

    // Notify submitter privately
    const submitterAssignment = updated.roleAssignments?.find((r) => r.role === 'SUBMITTER' || r.role === 'LEAD_SINGER');
    const submitterUserId = submitterAssignment?.userId;

    if (submitterUserId) {
      try {
        const notifId = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const notifTitle = 'Song Submission Update';
        const notifBody = rejectReason
          ? `Your song submission "${updated.title}" was not approved. Feedback: ${rejectReason}`
          : `Your song submission "${updated.title}" was not approved at this time.`;

        const notif = await prisma.notification.create({
          data: {
            id: notifId,
            title: notifTitle,
            body: notifBody,
            type: 'warning',
            category: 'rehearsal',
            priority: 'normal',
            organizationId: updated.organizationId || 'zone-001',
            senderId: auth.userId || auth.id,
          },
        });

        await prisma.notificationDelivery.create({
          data: {
            notificationId: notifId,
            userId: submitterUserId,
            isRead: false,
          },
        });

        broadcast('notifications', submitterUserId, notif);

        sendExpoPushToUsers([submitterUserId], {
          title: notifTitle,
          body: notifBody,
          data: {
            notificationId: notifId,
            category: 'rehearsal',
            songId: id,
          },
        }).catch((err) => console.warn('[submitted-songs:reject:push]', err));
      } catch (notifErr) {
        console.warn('[submitted-songs:reject:notif]', notifErr);
      }
    }

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('[submitted-songs:reject]', err);
    res.status(500).json({ success: false, error: 'Failed to reject song' });
  }
});

/** PATCH /submitted-songs/:id — Update song submission */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({
      where: { id },
      include: { organization: true, roleAssignments: { include: { user: true } } },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Submission not found' });

    const data: Record<string, any> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.writer !== undefined) data.writer = body.writer;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.solfas !== undefined) data.solfas = body.solfas;
    if (body.leadSinger !== undefined) data.leadSinger = body.leadSinger;
    if (body.audioUrl !== undefined || body.audioFile !== undefined) data.audioFile = body.audioUrl || body.audioFile;
    if (body.status !== undefined) data.status = body.status;

    let updated = existing;
    if (Object.keys(data).length > 0) {
      updated = await prisma.song.update({
        where: { id },
        data,
        include: { organization: true, roleAssignments: { include: { user: true } } },
      });
    }

    // Update meta (conversation, reviewNotes, rejectNotes, notes)
    const metaKey = `submitted_song_meta_${id}`;
    const metaRow = await prisma.setting.findUnique({ where: { key: metaKey } });
    const currentMeta = (metaRow?.value as any) || {};

    let metaChanged = false;
    if (Array.isArray(body.conversation)) {
      currentMeta.conversation = body.conversation;
      metaChanged = true;
    }
    if (body.notes !== undefined) {
      currentMeta.notes = body.notes;
      metaChanged = true;
    }
    if (body.reviewNotes !== undefined || body.rejectNotes !== undefined) {
      currentMeta.reviewNotes = body.reviewNotes || body.rejectNotes;
      currentMeta.rejectNotes = body.rejectNotes || body.reviewNotes;
      metaChanged = true;
    }

    if (metaChanged) {
      await prisma.setting.upsert({
        where: { key: metaKey },
        create: { key: metaKey, value: currentMeta },
        update: { value: currentMeta },
      });
    }

    const formatted = shapeSubmission(updated, currentMeta);
    broadcast('submitted_song', id, formatted);
    res.json({ success: true, message: 'Submission updated', data: formatted });
  } catch (err) {
    console.error('[submitted-songs:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update submission' });
  }
});

/** DELETE /submitted-songs/:id — Delete submission */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await prisma.song.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Submission not found' });
    }

    await prisma.$transaction([
      prisma.songRoleAssignment.deleteMany({ where: { songId: id } }),
      prisma.programSong.deleteMany({ where: { songId: id } }),
      prisma.songCategory.deleteMany({ where: { songId: id } }),
      prisma.playlistItem.deleteMany({ where: { songId: id } }),
      prisma.mediaDoodle.deleteMany({ where: { songId: id } }),
      prisma.userSongNote.deleteMany({ where: { songId: id } }),
      prisma.songHistory.deleteMany({ where: { songId: id } }),
      prisma.song.delete({ where: { id } }),
    ]);
    await prisma.setting.delete({ where: { key: `submitted_song_meta_${id}` } }).catch(() => {});

    broadcast('submitted_song', id, { id, deleted: true });
    res.json({ success: true, message: 'Submission deleted' });
  } catch (err: any) {
    console.error('[submitted-songs:delete]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete submission' });
  }
});

export default router;
