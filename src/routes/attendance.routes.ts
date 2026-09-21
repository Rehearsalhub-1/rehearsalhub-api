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
    const { zoneId, programId } = req.query as Record<string, string>;
    const effectiveZoneId = zoneId || req.tenant?.effectiveZoneId || null;
    const isGlobal = req.tenant?.isHQAdmin && (req.tenant?.isGlobalView || !effectiveZoneId);

    const whereClause: any = {};
    if (!isGlobal) {
      whereClause.organizationId = effectiveZoneId || 'zone-001';
    }
    if (programId) {
      whereClause.programId = programId;
    }

    const rows = await prisma.attendance.findMany({
      where: whereClause,
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

/** GET /attendance/session — Get live clock-in status for a zone */
router.get('/session', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId } = req.query as { zoneId?: string };
    const effectiveZoneId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const key = `clockin_session_${effectiveZoneId}`;

    const setting = await prisma.setting.findUnique({ where: { key } });
    const val: any = setting?.value || {};

    res.json({
      success: true,
      data: {
        zoneId: effectiveZoneId,
        isOpen: val.isOpen !== false, // Defaults to true if never explicitly closed
        lastToggledAt: val.lastToggledAt || null,
        toggledBy: val.toggledBy || null,
      },
    });
  } catch (err) {
    console.error('[attendance:session:get]', err);
    res.status(500).json({ success: false, error: 'Failed to check clock-in session' });
  }
});

/** POST /attendance/session/toggle — Open or close rehearsal clock-in */
router.post('/session/toggle', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { zoneId, isOpen } = req.body;
    const effectiveZoneId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const key = `clockin_session_${effectiveZoneId}`;

    const updatedValue = {
      isOpen: Boolean(isOpen),
      lastToggledAt: new Date().toISOString(),
      toggledBy: auth.userId || auth.id || 'Coordinator',
    };

    await prisma.setting.upsert({
      where: { key },
      update: { value: updatedValue },
      create: { key, value: updatedValue },
    });

    res.json({
      success: true,
      data: {
        zoneId: effectiveZoneId,
        ...updatedValue,
      },
    });
  } catch (err) {
    console.error('[attendance:session:toggle]', err);
    res.status(500).json({ success: false, error: 'Failed to toggle clock-in session' });
  }
});

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const f1 = (lat1 * Math.PI) / 180;
  const f2 = (lat2 * Math.PI) / 180;
  const df = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(df / 2) * Math.sin(df / 2) + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** POST /attendance/check-in & POST /attendance */
const handleCheckIn = async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const { userId, programId, eventName, qrCode, zoneId, latitude, longitude } = req.body;
    const targetUserId = userId || auth.userId;
    const orgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const now = new Date();
    const id = (typeof req.body.id === 'string' && req.body.id.trim())
      ? req.body.id.trim()
      : `att_${crypto.randomUUID()}`;

    // 1. Guard: Check if clock-in session is open for this zone
    const sessionKey = `clockin_session_${orgId}`;
    const sessionSetting = await prisma.setting.findUnique({ where: { key: sessionKey } });
    const sessionVal: any = sessionSetting?.value || {};
    if (sessionVal.isOpen === false) {
      return res.status(403).json({
        success: false,
        error: 'Clock-in is currently closed for this rehearsal. Late arrivals cannot check in.',
      });
    }

    // 2. Guard: Enforce geofence location verification if configured
    const geofenceKeys = [`geofence_${orgId}`, 'geofence_hq', 'geofence'];
    const geofenceSettings = await prisma.setting.findMany({
      where: { key: { in: geofenceKeys } },
    });
    const activeGeofenceSetting =
      geofenceSettings.find((s) => s.key === `geofence_${orgId}`) ||
      geofenceSettings.find((s) => s.key === 'geofence_hq') ||
      geofenceSettings[0];

    const geoVal: any = activeGeofenceSetting?.value;
    if (geoVal && geoVal.isEnabled !== false && geoVal.latitude != null && geoVal.longitude != null) {
      const userLat = latitude != null ? parseFloat(latitude) : null;
      const userLon = longitude != null ? parseFloat(longitude) : null;

      if (userLat == null || userLon == null || isNaN(userLat) || isNaN(userLon)) {
        return res.status(400).json({
          success: false,
          error: 'Location coordinates are required to verify attendance at the rehearsal venue.',
        });
      }

      const venueLat = parseFloat(geoVal.latitude);
      const venueLon = parseFloat(geoVal.longitude);
      const allowedRadius = parseFloat(geoVal.radius) || 250;
      const distance = calculateDistance(userLat, userLon, venueLat, venueLon);

      if (distance > allowedRadius) {
        return res.status(403).json({
          success: false,
          error: `You are outside the rehearsal venue (${Math.round(distance)}m away from ${geoVal.venueName || 'venue'}). Maximum allowed distance is ${Math.round(allowedRadius)}m.`,
        });
      }
    }

    // 3. Guard: Enforce ONLY ONCE A DAY clock-in rule
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const existingToday = await prisma.attendance.findFirst({
      where: {
        userId: targetUserId,
        checkInTime: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: { user: true },
    });

    if (existingToday) {
      return res.status(409).json({
        success: false,
        error: 'You have already clocked in for today.',
        data: shapeAttendance(existingToday),
      });
    }

    // 4. Resolve active program if any
    let resolvedProgramId: string | null = null;
    if (programId && typeof programId === 'string' && programId !== 'general_rehearsal') {
      const exists = await prisma.program.findUnique({ where: { id: programId } });
      if (exists) resolvedProgramId = programId;
    }
    if (!resolvedProgramId) {
      const activeProgram = await prisma.program.findFirst({
        where: {
          organizationId: orgId,
          isActive: true,
        },
        select: { id: true },
      });
      resolvedProgramId = activeProgram?.id || null;
    }

    const inserted = await prisma.attendance.create({
      data: {
        id,
        organizationId: orgId,
        userId: targetUserId,
        programId: resolvedProgramId,
        eventName: eventName || (resolvedProgramId ? 'Program Rehearsal' : 'General Rehearsal'),
        status: 'present',
        checkInTime: now,
        scannedAt: qrCode ? now : null,
        qrCode: qrCode || null,
        recordedById: auth.userId,
      },
      include: { user: true },
    });

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
