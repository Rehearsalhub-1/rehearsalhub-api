import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';

const router = Router();

function shapeAttendance(row: any) {
  const user = row.user || {};
  const manualName = typeof row.qrCode === 'string' && row.qrCode.startsWith('manual:')
    ? row.qrCode.slice(7).trim()
    : '';
  const userName = manualName || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Singer';
  const checkInTime = row.checkInTime || row.scannedAt || row.createdAt;
  const d = checkInTime ? new Date(checkInTime) : null;
  const dateString = d ? d.toLocaleDateString('en-CA') : '';
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
    checkInTime,
    dateString,
    date_string: dateString,
    scannedAt: row.scannedAt || null,
    qrCode: manualName ? null : (row.qrCode || null),
    method: manualName ? 'manual' : (row.qrCode ? 'scanner' : undefined),
    isManual: Boolean(manualName),
    recordedById: row.recordedById || null,
    createdAt: row.createdAt,
  };
}

/** GET /attendance — List attendance */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId, subGroupId, churchId, groupId, programId, limit, date, startDate, endDate, month } = req.query as Record<string, string>;
    const effectiveZoneId = zoneId || req.tenant?.effectiveZoneId || null;
    const effectiveChurchId = subGroupId || churchId || groupId || (req.tenant?.mode === 'church' ? req.tenant?.effectiveChurchId : null) || null;
    const isGlobal = req.tenant?.isHQAdmin && (req.tenant?.isGlobalView || !effectiveZoneId) && !effectiveChurchId;

    const whereClause: any = {};
    if (!isGlobal) {
      whereClause.organizationId = effectiveZoneId || 'zone-001';
    }
    if (effectiveChurchId) {
      whereClause.user = {
        memberships: {
          some: { groupId: effectiveChurchId },
        },
      };
    }
    if (programId) {
      whereClause.programId = programId;
    }

    // Date filtering support
    if (date) {
      const dayStart = new Date(`${date}T00:00:00.000Z`);
      const dayEnd = new Date(`${date}T23:59:59.999Z`);
      // 14-hour buffer to handle all international timezone shifts
      whereClause.OR = [
        { checkInTime: { gte: new Date(dayStart.getTime() - 14 * 3600 * 1000), lte: new Date(dayEnd.getTime() + 14 * 3600 * 1000) } },
        { createdAt: { gte: new Date(dayStart.getTime() - 14 * 3600 * 1000), lte: new Date(dayEnd.getTime() + 14 * 3600 * 1000) } },
      ];
    } else if (startDate || endDate) {
      const s = startDate ? new Date(startDate) : new Date('2020-01-01');
      const e = endDate ? new Date(endDate) : new Date('2099-12-31');
      whereClause.OR = [
        { checkInTime: { gte: s, lte: e } },
        { createdAt: { gte: s, lte: e } },
      ];
    } else if (month) {
      // e.g. "2026-10"
      const [year, m] = month.split('-').map(Number);
      const s = new Date(Date.UTC(year, m - 1, 1, 0, 0, 0));
      const e = new Date(Date.UTC(year, m, 0, 23, 59, 59, 999));
      whereClause.OR = [
        { checkInTime: { gte: s, lte: e } },
        { createdAt: { gte: s, lte: e } },
      ];
    }

    const takeLimit = limit === 'all'
      ? 100000
      : Math.min(parseInt(limit as string, 10) || 50000, 100000);

    const rows = await prisma.attendance.findMany({
      where: whereClause,
      include: {
        user: true,
      },
      orderBy: { checkInTime: 'desc' },
      take: takeLimit,
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
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 1000, 5000);
    const rows = await prisma.attendance.findMany({
      where: { userId },
      include: { user: true },
      orderBy: { checkInTime: 'desc' },
      take: limit,
    });
    res.json({ success: true, count: rows.length, data: rows.map(shapeAttendance) });
  } catch (err) {
    console.error('[attendance/mine]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch personal attendance' });
  }
};

router.get('/mine', requireAuth, handleGetMyAttendance);
router.get('/personal', requireAuth, handleGetMyAttendance);

/** GET /attendance/session — Get live clock-in status for a zone or church */
router.get('/session', requireAuth, async (req: Request, res: Response) => {
  try {
    const { zoneId, subGroupId, churchId } = req.query as { zoneId?: string; subGroupId?: string; churchId?: string };
    const effectiveChurchId = subGroupId || churchId || (req.tenant?.mode === 'church' ? req.tenant?.effectiveChurchId : null) || null;
    const effectiveScopeId = effectiveChurchId || zoneId || req.tenant?.effectiveZoneId || res.locals.auth?.zoneId || null;
    if (!effectiveScopeId) {
      return res.status(400).json({ success: false, error: 'zoneId query param or tenant scope is required' });
    }
    const key = `clockin_session_${effectiveScopeId}`;

    const setting = await prisma.setting.findUnique({ where: { key } });
    const val: any = setting?.value || {};

    res.json({
      success: true,
      data: {
        zoneId: effectiveScopeId,
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
    const { zoneId, subGroupId, churchId, isOpen } = req.body;
    const effectiveChurchId = subGroupId || churchId || (req.tenant?.mode === 'church' ? req.tenant?.effectiveChurchId : null) || null;
    const effectiveScopeId = effectiveChurchId || zoneId || req.tenant?.effectiveZoneId || res.locals.auth?.zoneId || null;
    if (!effectiveScopeId) {
      return res.status(400).json({ success: false, error: 'zoneId is required to toggle session' });
    }
    const key = `clockin_session_${effectiveScopeId}`;

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
        zoneId: effectiveScopeId,
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
  let targetUserId = req.body?.userId || res.locals.auth?.userId;
  try {
    const auth = res.locals.auth;
    const {
      userId,
      user_name,
      userName,
      programId,
      eventName,
      qrCode,
      zoneId,
      churchId,
      subGroupId,
      latitude,
      longitude,
      isMocked,
      method,
    } = req.body;
    if (isMocked === true || req.body?.mocked === true) {
      return res.status(403).json({
        success: false,
        error: 'Simulated location or mock GPS detected. Clock-in rejected.',
      });
    }
    let effectiveChurchId = churchId || subGroupId || req.tenant?.effectiveChurchId || auth?.churchId || null;
    let orgId = zoneId || req.tenant?.effectiveZoneId || auth?.zoneId;
    if (orgId && String(orgId).startsWith('grp_')) {
      effectiveChurchId = effectiveChurchId || String(orgId);
      const grp = await prisma.group.findUnique({ where: { id: String(orgId) }, select: { organizationId: true } });
      orgId = grp?.organizationId || req.tenant?.effectiveZoneId || auth?.zoneId;
    }
    if (!orgId && effectiveChurchId) {
      const grp = await prisma.group.findUnique({ where: { id: String(effectiveChurchId) }, select: { organizationId: true } });
      orgId = grp?.organizationId || undefined;
    }
    if (!orgId) {
      const userMem = await prisma.membership.findFirst({
        where: { userId: targetUserId, status: 'ACTIVE' },
        select: { organizationId: true },
      });
      orgId = userMem?.organizationId;
    }
    if (!orgId) {
      return res.status(400).json({ success: false, error: 'Zone identification is required for attendance clock-in.' });
    }

    const manualSingerName = (typeof user_name === 'string' && user_name.trim()) || (typeof userName === 'string' && userName.trim()) || '';
    let isUnmatchedManual = false;
    if (!userId && manualSingerName) {
      // Try to resolve singer by name within the organization
      const parts = manualSingerName.split(/\s+/);
      const first = parts[0] || '';
      const last = parts.slice(1).join(' ');
      const matchedMembership = await prisma.membership.findFirst({
        where: {
          organizationId: orgId,
          ...(effectiveChurchId ? { groupId: effectiveChurchId } : {}),
          user: {
            firstName: { equals: first, mode: 'insensitive' },
            ...(last ? { lastName: { equals: last, mode: 'insensitive' } } : {}),
          },
        },
        select: { userId: true },
      });
      if (matchedMembership?.userId) {
        targetUserId = matchedMembership.userId;
      } else {
        isUnmatchedManual = true;
      }
    }

    const now = new Date();
    const id = (typeof req.body.id === 'string' && req.body.id.trim())
      ? req.body.id.trim()
      : `att_${crypto.randomUUID()}`;

    // 1. Guard: Check if clock-in session is open for this church or zone
    const sessionKey = `clockin_session_${effectiveChurchId || orgId}`;
    const sessionSetting = await prisma.setting.findUnique({ where: { key: sessionKey } });
    const sessionVal: any = sessionSetting?.value || {};
    if (sessionVal.isOpen === false && method !== 'manual' && method !== 'scanner') {
      return res.status(403).json({
        success: false,
        error: 'Clock-in is currently closed for this rehearsal. Late arrivals cannot check in.',
      });
    }

    // 2. Guard: Enforce geofence location verification if configured (skip for admin manual/scanner check-in)
    // Developer/owner bypass — this user participates remotely and is exempt from geofence.
    const REMOTE_EXEMPT_USERS = new Set(['8ILWjbl9IbgbuxBK9P23mB6pZBt1']);
    const isRemoteExempt = REMOTE_EXEMPT_USERS.has(targetUserId) || method === 'manual' || method === 'scanner';

    const isHQ = orgId === 'zone-001' || orgId === 'hq' || orgId === 'loveworld-singers-hq';
    const candidateKeys = [
      effectiveChurchId ? `geofence_${effectiveChurchId}` : null,
      orgId ? `geofence_${orgId}` : null,
      isHQ ? 'geofence_hq' : null,
      isHQ ? 'geofence' : null,
    ].filter(Boolean) as string[];

    const geofenceSettings = await prisma.setting.findMany({
      where: { key: { in: candidateKeys } },
    });

    let activeGeofenceSetting: (typeof geofenceSettings)[number] | null = null;
    for (const k of candidateKeys) {
      const match = geofenceSettings.find((s) => s.key === k);
      if (match) {
        activeGeofenceSetting = match;
        break;
      }
    }

    const geoVal: any = activeGeofenceSetting?.value;
    if (!isRemoteExempt && geoVal && geoVal.isEnabled !== false && geoVal.latitude != null && geoVal.longitude != null) {
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

    // 3. Guard: Enforce ONLY ONCE A DAY clock-in rule (skip if unmatched manual entry by admin)
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    if (!isUnmatchedManual) {
      const existingToday = await prisma.attendance.findFirst({
        where: {
          userId: targetUserId,
          OR: [
            { checkInTime: { gte: startOfDay, lte: endOfDay } },
            { createdAt: { gte: startOfDay, lte: endOfDay } },
          ],
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
          ...(effectiveChurchId ? { groupId: effectiveChurchId } : {}),
          isActive: true,
        },
        select: { id: true },
      });
      resolvedProgramId = activeProgram?.id || null;
    }

    const effectiveQrCode = qrCode || (isUnmatchedManual && manualSingerName ? `manual:${manualSingerName}` : null);

    const inserted = await prisma.attendance.create({
      data: {
        id,
        organizationId: orgId,
        userId: targetUserId,
        programId: resolvedProgramId,
        eventName:
          (typeof eventName === 'string' && eventName.trim()) ||
          (typeof geoVal?.activeEventName === 'string' && geoVal.activeEventName.trim()) ||
          (resolvedProgramId ? 'Program Rehearsal' : 'General Rehearsal'),
        status: 'present',
        checkInTime: now,
        scannedAt: qrCode ? now : null,
        qrCode: effectiveQrCode,
        recordedById: auth.userId,
      },
      include: { user: true },
    });

    res.status(201).json({ success: true, message: 'Checked in successfully', data: shapeAttendance(inserted) });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      try {
        const fallback = await prisma.attendance.findFirst({
          where: { userId: targetUserId },
          orderBy: { createdAt: 'desc' },
          include: { user: true },
        });
        if (fallback) {
          return res.status(200).json({
            success: true,
            message: 'Checked in successfully',
            data: shapeAttendance(fallback),
          });
        }
      } catch {}
    }
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
    const { userId, user_name, userName, programId, eventName, status = 'present', zoneId, churchId, subGroupId } = req.body;
    const manualSingerName = (typeof user_name === 'string' && user_name.trim()) || (typeof userName === 'string' && userName.trim()) || '';
    const resolvedUserId = userId || auth?.userId;
    if (!resolvedUserId) return res.status(400).json({ success: false, error: 'userId is required' });

    const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let orgId = zoneId || req.tenant?.effectiveZoneId || auth?.zoneId;
    if (orgId && String(orgId).startsWith('grp_')) {
      const grp = await prisma.group.findUnique({ where: { id: String(orgId) }, select: { organizationId: true } });
      orgId = grp?.organizationId || req.tenant?.effectiveZoneId || auth?.zoneId;
    }
    if (!orgId && (churchId || subGroupId)) {
      const grp = await prisma.group.findUnique({ where: { id: String(churchId || subGroupId) }, select: { organizationId: true } });
      orgId = grp?.organizationId || undefined;
    }
    if (!orgId) {
      const userMem = await prisma.membership.findFirst({
        where: { userId: resolvedUserId, status: 'ACTIVE' },
        select: { organizationId: true },
      });
      orgId = userMem?.organizationId;
    }
    if (!orgId) {
      return res.status(400).json({ success: false, error: 'Zone identification is required for attendance recording.' });
    }
    const now = new Date();

    const inserted = await prisma.attendance.create({
      data: {
        id,
        organizationId: orgId,
        userId: resolvedUserId,
        programId: programId || null,
        eventName: eventName || 'Rehearsal',
        status,
        checkInTime: now,
        qrCode: !userId && manualSingerName ? `manual:${manualSingerName}` : null,
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
