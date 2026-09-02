import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

function shapeAttendance(row: any) {
  const user = row.user || {};
  const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Singer';
  return {
    id: row.id,
    userId: row.userId,
    userName,
    userEmail: user.email || '',
    userAvatar: user.avatarUrl || null,
    eventName: row.eventName || 'Rehearsal',
    status: row.status || 'present',
    organizationId: row.organizationId,
    zoneId: row.organizationId,
    checkInTime: row.checkInTime || row.createdAt,
    scannedAt: row.scannedAt || null,
    qrCode: row.qrCode || null,
    recordedById: row.recordedById || null,
    createdAt: row.createdAt,
  };
}

/** GET /attendance — List attendance */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId, programId, date } = req.query as Record<string, string>;
    const effectiveZoneId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    const rows = await prisma.attendance.findMany({
      where: {
        OR: [
          { organizationId: effectiveZoneId },
          { organizationId: 'zone-001' },
        ],
        ...(programId ? { programId } : {}),
      },
      include: {
        user: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    res.json({ success: true, count: rows.length, data: rows.map(shapeAttendance) });
  } catch (err) {
    console.error('[attendance:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load attendance records' });
  }
});

/** GET /attendance/mine & /attendance/personal — Current user's records */
const handleGetMyAttendance = async (req: Request, res: Response) => {
  try {
    const userId = res.locals.auth.userId as string;
    const rows = await prisma.attendance.findMany({
      where: { userId },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ success: true, count: rows.length, data: rows.map(shapeAttendance) });
  } catch (err) {
    console.error('[attendance/mine]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch personal attendance' });
  }
};

router.get('/mine', requireAuth, handleGetMyAttendance);
router.get('/personal', requireAuth, handleGetMyAttendance);

/** POST /attendance/check-in & POST /attendance */
const handleCheckIn = async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { userId, programId, eventName, qrCode, zoneId } = req.body;
    const targetUserId = userId || auth.userId;
    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const now = new Date();
    const id = req.body.id || `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Validate or resolve valid programId
    let resolvedProgramId: string | null = null;
    if (programId && typeof programId === 'string' && programId !== 'general_rehearsal') {
      const exists = await prisma.program.findUnique({ where: { id: programId } });
      if (exists) resolvedProgramId = programId;
    }
    if (!resolvedProgramId) {
      const activeProgram = await prisma.program.findFirst({
        where: {
          OR: [
            { organizationId: orgId },
            { organizationId: 'zone-001' },
          ],
          isActive: true,
        },
        select: { id: true },
      });
      resolvedProgramId = activeProgram?.id || null;
    }

    let inserted;
    if (resolvedProgramId) {
      inserted = await prisma.attendance.upsert({
        where: {
          programId_userId: {
            programId: resolvedProgramId,
            userId: targetUserId,
          },
        },
        update: {
          status: 'present',
          checkInTime: now,
          scannedAt: qrCode ? now : undefined,
          qrCode: qrCode || undefined,
          recordedById: auth.userId,
        },
        create: {
          id,
          organizationId: orgId,
          userId: targetUserId,
          programId: resolvedProgramId,
          eventName: eventName || 'Rehearsal',
          status: 'present',
          checkInTime: now,
          scannedAt: qrCode ? now : null,
          qrCode: qrCode || null,
          recordedById: auth.userId,
        },
        include: { user: true },
      });
    } else {
      inserted = await prisma.attendance.create({
        data: {
          id,
          organizationId: orgId,
          userId: targetUserId,
          eventName: eventName || 'General Rehearsal',
          status: 'present',
          checkInTime: now,
          scannedAt: qrCode ? now : null,
          qrCode: qrCode || null,
          recordedById: auth.userId,
        },
        include: { user: true },
      });
    }

    res.status(201).json({ success: true, message: 'Checked in successfully', data: shapeAttendance(inserted) });
  } catch (err: any) {
    console.error('[attendance:check-in]', err);
    res.status(500).json({ success: false, error: err?.message || 'Check-in failed' });
  }
};

router.post('/check-in', requireAuth, handleCheckIn);
router.post('/', requireAuth, handleCheckIn);

/** POST /attendance/manual — Admin adds manual entry */
router.post('/manual', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { userId, programId, eventName, status = 'present', zoneId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });

    const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const now = new Date();

    const inserted = await prisma.attendance.create({
      data: {
        id,
        organizationId: orgId,
        userId,
        programId: programId || null,
        eventName: eventName || 'Rehearsal',
        status,
        checkInTime: now,
        recordedById: auth.userId,
      },
      include: { user: true },
    });

    res.status(201).json({ success: true, message: 'Manual attendance recorded', data: shapeAttendance(inserted) });
  } catch (err: any) {
    console.error('[attendance:manual]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to save attendance' });
  }
});

/** PATCH /attendance/:id — Admin update attendance record */
router.patch('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { eventName, status } = req.body;

    const updated = await prisma.attendance.update({
      where: { id },
      data: {
        ...(eventName !== undefined ? { eventName } : {}),
        ...(status !== undefined ? { status } : {}),
      },
      include: { user: true },
    });

    res.json({ success: true, message: 'Attendance record updated', data: shapeAttendance(updated) });
  } catch (err) {
    console.error('[attendance:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update record' });
  }
});

/** DELETE /attendance/:id — Delete attendance record */
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.attendance.delete({ where: { id } });
    res.json({ success: true, message: 'Attendance record deleted' });
  } catch (err) {
    console.error('[attendance:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete attendance' });
  }
});

/** GET /attendance/code — Get current attendance check-in code */
router.get('/code', requireAuth, async (req: Request, res: Response) => {
  try {
    const effectiveZoneId = req.query.zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const key = `attendance_code_${effectiveZoneId}`;
    const setting = await prisma.setting.findUnique({ where: { key } });
    const val = setting?.value && typeof setting.value === 'object' ? (setting.value as any) : {};
    res.json({ success: true, data: { code: val.code || '', active: val.active ?? false, zoneId: effectiveZoneId } });
  } catch (err) {
    console.error('[attendance/code:GET]', err);
    res.json({ success: true, data: { code: '', active: false } });
  }
});

/** POST /attendance/code — Set or toggle attendance check-in code */
router.post('/code', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { code, active, zoneId } = req.body;
    const effectiveZoneId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const key = `attendance_code_${effectiveZoneId}`;

    const updated = await prisma.setting.upsert({
      where: { key },
      update: {
        value: {
          code: code || '',
          active: active ?? true,
          updatedAt: new Date().toISOString(),
        },
      },
      create: {
        key,
        value: {
          code: code || '',
          active: active ?? true,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    res.json({ success: true, data: updated.value });
  } catch (err) {
    console.error('[attendance/code:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to update attendance code' });
  }
});

export default router;
