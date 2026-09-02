import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

function shapeGroup(g: any) {
  return {
    id: g.id,
    name: g.name,
    code: g.name.slice(0, 4).toUpperCase(),
    organizationId: g.organizationId,
    zoneId: g.organizationId,
    type: g.type || 'church',
    status: g.status || 'active',
    description: g.description || '',
    estimatedMembers: g.estimatedMembers || 0,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/** GET /subgroups/mine */
router.get('/mine', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const memberships = await prisma.membership.findMany({
      where: { userId, groupId: { not: null } },
      include: { group: true },
    });

    const groups = memberships.map((m) => m.group).filter(Boolean);
    res.json({ success: true, data: groups.map(shapeGroup) });
  } catch (err) {
    console.error('[subgroups/mine]', err);
    res.status(500).json({ success: false, error: 'Failed to load your groups' });
  }
});

/** GET /subgroups/coordinated */
router.get('/coordinated', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const memberships = await prisma.membership.findMany({
      where: { userId, role: 'GROUP_ADMIN', groupId: { not: null } },
      include: { group: true },
    });

    const groups = memberships.map((m) => m.group).filter(Boolean);
    res.json({ success: true, data: groups.map(shapeGroup) });
  } catch (err) {
    console.error('[subgroups/coordinated]', err);
    res.status(500).json({ success: false, error: 'Failed to load coordinated groups' });
  }
});

/** GET /subgroups/requests — List pending group approval requests */
router.get('/requests', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const effectiveZoneId = req.tenant?.effectiveZoneId || 'zone-001';

    const groups = await prisma.group.findMany({
      where: {
        status: 'pending',
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, count: groups.length, data: groups.map(shapeGroup) });
  } catch (err) {
    console.error('[subgroups/requests]', err);
    res.status(500).json({ success: false, error: 'Failed to load group requests' });
  }
});

/** GET /subgroups - List groups */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const effectiveZoneId = req.tenant?.effectiveZoneId || 'zone-001';

    const groups = await prisma.group.findMany({
      where: {
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
        ],
      },
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, count: groups.length, data: groups.map(shapeGroup) });
  } catch (err) {
    console.error('[subgroups/ GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load groups' });
  }
});

/** GET /subgroups/:id */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const group = await prisma.group.findUnique({ where: { id: req.params.id } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
    res.json({ success: true, data: shapeGroup(group) });
  } catch (err) {
    console.error('[subgroups/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load group' });
  }
});

/** GET /subgroups/:id/members — List members in this group */
router.get('/:id/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const memberships = await prisma.membership.findMany({
      where: { groupId: id },
      include: { user: true },
    });

    const members = memberships.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.user.email,
      name: [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') || m.user.email || 'Member',
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      status: m.status,
      voicePart: m.voicePart,
      joinedAt: m.joinedAt,
    }));

    res.json({ success: true, count: members.length, data: members });
  } catch (err) {
    console.error('[subgroups/:id/members:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load members' });
  }
});

/** POST /subgroups/:id/members — Add user to church/group */
router.post('/:id/members', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: group.organizationId },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: id },
      });
    } else {
      await prisma.membership.create({
        data: {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId,
          organizationId: group.organizationId,
          groupId: id,
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });
    }

    res.json({ success: true, message: 'Member added to group' });
  } catch (err) {
    console.error('[subgroups/:id/members:post]', err);
    res.status(500).json({ success: false, error: 'Failed to add member' });
  }
});

/** DELETE /subgroups/:id/members/:userId — Remove user from group */
router.delete('/:id/members/:userId', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id, userId } = req.params;
    const membership = await prisma.membership.findFirst({
      where: { userId, groupId: id },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: null },
      });
    }

    res.json({ success: true, message: 'Member removed from group' });
  } catch (err) {
    console.error('[subgroups/:id/members:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

/** POST /subgroups/:id/assign-coordinator */
router.post('/:id/assign-coordinator', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { email, userId } = req.body;

    let targetUser: any = null;
    if (userId) {
      targetUser = await prisma.user.findUnique({ where: { id: userId } });
    } else if (email) {
      targetUser = await prisma.user.findFirst({ where: { email: email.toLowerCase().trim() } });
    }

    if (!targetUser) return res.status(404).json({ success: false, error: 'User not found' });

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const membership = await prisma.membership.findFirst({
      where: { userId: targetUser.id, organizationId: group.organizationId },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: id, role: 'GROUP_ADMIN' },
      });
    } else {
      await prisma.membership.create({
        data: {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: targetUser.id,
          organizationId: group.organizationId,
          groupId: id,
          role: 'GROUP_ADMIN',
          status: 'ACTIVE',
        },
      });
    }

    res.json({ success: true, message: 'Coordinator assigned successfully' });
  } catch (err) {
    console.error('[subgroups/:id/assign-coordinator]', err);
    res.status(500).json({ success: false, error: 'Failed to assign coordinator' });
  }
});

/** POST /subgroups/:id/coordinators — Alias for assign-coordinator */
router.post('/:id/coordinators', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { email, userId } = req.body;

    let targetUser: any = null;
    if (userId) {
      targetUser = await prisma.user.findUnique({ where: { id: userId } });
    } else if (email) {
      targetUser = await prisma.user.findFirst({ where: { email: email.toLowerCase().trim() } });
    }

    if (!targetUser) return res.status(404).json({ success: false, error: 'User not found' });

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const membership = await prisma.membership.findFirst({
      where: { userId: targetUser.id, organizationId: group.organizationId },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: id, role: 'GROUP_ADMIN' },
      });
    } else {
      await prisma.membership.create({
        data: {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: targetUser.id,
          organizationId: group.organizationId,
          groupId: id,
          role: 'GROUP_ADMIN',
          status: 'ACTIVE',
        },
      });
    }

    res.json({ success: true, message: 'Coordinator assigned successfully' });
  } catch (err) {
    console.error('[subgroups/:id/coordinators]', err);
    res.status(500).json({ success: false, error: 'Failed to assign coordinator' });
  }
});

/** POST /subgroups/:id/approve — Approve pending church/subgroup */
router.post('/:id/approve', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const group = await prisma.group.update({
      where: { id },
      data: { status: 'active' },
    });
    res.json({ success: true, message: 'Group approved', data: shapeGroup(group) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to approve group' });
  }
});

/** POST /subgroups/:id/reject — Reject pending church/subgroup */
router.post('/:id/reject', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const group = await prisma.group.update({
      where: { id },
      data: { status: 'rejected' },
    });
    res.json({ success: true, message: 'Group rejected', data: shapeGroup(group) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to reject group' });
  }
});

/** POST /subgroups/members — Add member to subgroup with body { subGroupId, userId } */
router.post('/members', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId, userId } = req.body;
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId || !userId) return res.status(400).json({ success: false, error: 'subGroupId and userId are required' });

    const group = await prisma.group.findUnique({ where: { id: targetGroupId } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: group.organizationId },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: targetGroupId },
      });
    } else {
      await prisma.membership.create({
        data: {
          id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId,
          organizationId: group.organizationId,
          groupId: targetGroupId,
          role: 'MEMBER',
          status: 'ACTIVE',
        },
      });
    }

    res.json({ success: true, message: 'Member added to group' });
  } catch (err) {
    console.error('[subgroups/members:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to add member' });
  }
});

/** DELETE /subgroups/members — Remove member from subgroup with query ?subGroupId=...&userId=... */
router.delete('/members', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId, userId } = req.query as Record<string, string>;
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId || !userId) return res.status(400).json({ success: false, error: 'subGroupId and userId are required' });

    const membership = await prisma.membership.findFirst({
      where: { userId, groupId: targetGroupId },
    });

    if (membership) {
      await prisma.membership.update({
        where: { id: membership.id },
        data: { groupId: null },
      });
    }

    res.json({ success: true, message: 'Member removed from group' });
  } catch (err) {
    console.error('[subgroups/members:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to remove member' });
  }
});

/** POST /subgroups - Create group */
router.post('/', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { name, description, type = 'church', zoneId, estimatedMembers } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Group name is required' });
    }

    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const group = await prisma.group.create({
      data: {
        id,
        organizationId: orgId,
        name: name.trim(),
        description: description?.trim() || null,
        type,
        status: 'active',
        estimatedMembers: Number(estimatedMembers) || 0,
      },
    });

    res.status(201).json({ success: true, data: shapeGroup(group) });
  } catch (err: any) {
    console.error('[subgroups POST]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to create group' });
  }
});

/** PATCH /subgroups/:id - Update group */
router.patch('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, type, status, estimatedMembers } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (type !== undefined) updateData.type = type;
    if (status !== undefined) updateData.status = status;
    if (estimatedMembers !== undefined) updateData.estimatedMembers = Number(estimatedMembers);

    const updated = await prisma.group.update({
      where: { id },
      data: updateData,
    });

    res.json({ success: true, data: shapeGroup(updated) });
  } catch (err: any) {
    console.error('[subgroups PATCH]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update group' });
  }
});

/** DELETE /subgroups/:id */
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.group.delete({ where: { id } });
    res.json({ success: true, message: 'Group deleted successfully' });
  } catch (err: any) {
    console.error('[subgroups DELETE]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete group' });
  }
});

/** POST /subgroups/songs — Create a new subgroup song */
router.post('/songs', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const body = req.body || {};
    const { title, key, writer, category, tempo, leadSinger, lyrics, audioFile, audioUrl, subGroupId, zoneId } = body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Song title is required' });
    }

    const id = `sgsong_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveOrgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    const created = await prisma.song.create({
      data: {
        id,
        title: title.trim(),
        key: key ? String(key).trim() : null,
        writer: writer ? String(writer).trim() : (auth.firstName || 'Member'),
        category: category ? String(category).trim() : 'Church Songs',
        tempo: tempo ? String(tempo).trim() : null,
        leadSinger: leadSinger ? String(leadSinger).trim() : null,
        lyrics: lyrics ? String(lyrics).trim() : null,
        audioFile: audioFile || audioUrl || null,
        organizationId: effectiveOrgId,
        groupId: subGroupId || null,
        status: 'active',
      },
    });

    res.status(201).json({ success: true, message: 'Song created successfully', data: created });
  } catch (err: any) {
    console.error('[subgroups:songs:create]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to create subgroup song' });
  }
});

/** PATCH /subgroups/songs/:id — Update subgroup song */
router.patch('/songs/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.status !== undefined) data.status = body.status;
    if (body.isActive !== undefined) data.status = body.isActive ? 'active' : 'inactive';
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.audioFile !== undefined || body.audioUrl !== undefined) data.audioFile = body.audioFile || body.audioUrl;

    const updated = await prisma.song.update({ where: { id }, data });
    res.json({ success: true, message: 'Subgroup song updated', data: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update song' });
  }
});

/** DELETE /subgroups/songs/:id — Delete subgroup song */
router.delete('/songs/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.song.delete({ where: { id } });
    res.json({ success: true, message: 'Subgroup song deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to delete song' });
  }
});

/** PATCH /subgroups/praise-nights/:id — Update subgroup program/rehearsal */
router.patch('/praise-nights/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const data: any = {};
    if (body.name !== undefined || body.title !== undefined) data.name = body.name || body.title;
    if (body.date !== undefined) data.date = body.date;
    if (body.status !== undefined) data.status = body.status;
    if (body.category !== undefined) data.category = body.category;
    if (body.location !== undefined) data.location = body.location;
    if (body.bannerImage !== undefined) data.bannerImage = body.bannerImage;

    if (Array.isArray(body.songIds)) {
      await prisma.programSong.deleteMany({ where: { programId: id } });
      if (body.songIds.length > 0) {
        await prisma.programSong.createMany({
          data: body.songIds.map((sId: string, idx: number) => ({
            programId: id,
            songId: sId,
            order: idx + 1,
          })),
        });
      }
    }

    const updated = await prisma.program.update({ where: { id }, data });
    res.json({ success: true, message: 'Subgroup program updated', data: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to update subgroup program' });
  }
});

/** GET /subgroups/songs — List subgroup songs */
router.get('/songs', requireAuth, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId } = req.query as Record<string, string>;
    const targetGroupId = subGroupId || groupId;

    const where: any = {};
    if (targetGroupId) {
      where.groupId = targetGroupId;
    } else {
      where.groupId = { not: null };
    }

    const songs = await prisma.song.findMany({
      where,
      orderBy: { title: 'asc' },
    });

    res.json({ success: true, count: songs.length, data: songs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to load subgroup songs' });
  }
});

/** POST /subgroups/songs/import — Import songs into subgroup */
router.post('/songs/import', requireAuth, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId, songIds = [] } = req.body;
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId || !Array.isArray(songIds)) {
      return res.status(400).json({ success: false, error: 'subGroupId and songIds array are required' });
    }

    const group = await prisma.group.findUnique({ where: { id: targetGroupId } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const songs = await prisma.song.findMany({ where: { id: { in: songIds } } });
    for (const song of songs) {
      const newId = `subsong_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await prisma.song.create({
        data: {
          id: newId,
          title: song.title,
          writer: song.writer,
          key: song.key,
          tempo: song.tempo,
          lyrics: song.lyrics,
          solfas: song.solfas,
          audioFile: song.audioFile,
          status: 'active',
          organizationId: group.organizationId,
          groupId: targetGroupId,
          category: 'Church Song',
        },
      });
    }

    res.json({ success: true, message: `${songs.length} song(s) imported into church.` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to import songs' });
  }
});

/** GET /subgroups/praise-nights — List subgroup rehearsals/programs */
router.get('/praise-nights', requireAuth, async (req: Request, res: Response) => {
  try {
    const { subGroupId, groupId } = req.query as Record<string, string>;
    const targetGroupId = subGroupId || groupId;

    const where: any = {};
    if (targetGroupId) {
      where.groupId = targetGroupId;
    } else {
      where.groupId = { not: null };
    }

    const programs = await prisma.program.findMany({
      where,
      include: {
        programSongs: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { date: 'desc' },
    });

    res.json({
      success: true,
      count: programs.length,
      data: programs.map((p) => ({
        ...p,
        subGroupId: p.groupId,
        songs: p.programSongs.map((ps) => ps.song),
        songCount: p.programSongs.length,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to load subgroup programs' });
  }
});

/** POST /subgroups/praise-nights — Create subgroup rehearsal/program */
router.post('/praise-nights', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { name, title, date, location, category, status, subGroupId, groupId, songIds = [] } = req.body;
    const targetGroupId = subGroupId || groupId;
    if (!targetGroupId) return res.status(400).json({ success: false, error: 'subGroupId is required' });

    const group = await prisma.group.findUnique({ where: { id: targetGroupId } });
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });

    const progId = req.body.id || `subprog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveCategory = category || (status === 'ongoing' ? 'ongoing' : 'pre-rehearsal');

    const created = await prisma.program.create({
      data: {
        id: progId,
        name: (name || title || 'Rehearsal').trim(),
        date: date || new Date().toISOString().split('T')[0],
        category: effectiveCategory,
        status: status || effectiveCategory,
        location: location || null,
        organizationId: group.organizationId,
        groupId: targetGroupId,
        ...(Array.isArray(songIds) && songIds.length > 0
          ? {
              programSongs: {
                create: songIds.map((sId: string, idx: number) => ({
                  songId: sId,
                  order: idx + 1,
                })),
              },
            }
          : {}),
      },
      include: {
        programSongs: {
          include: { song: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    res.status(201).json({ success: true, message: 'Subgroup rehearsal created', data: created });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to create subgroup rehearsal' });
  }
});

export default router;
