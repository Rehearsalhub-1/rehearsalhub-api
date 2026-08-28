import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { mergeRawRow } from '../lib/rawRow';

const router = Router();

function shapeAttendance(row: any) {
  const merged = mergeRawRow(row);
  const raw = (row.rawData && typeof row.rawData === 'object') ? (row.rawData as Record<string, any>) : {};

  const id = String(row.id);
  const userId = row.userId || raw.userId || raw.user_id || '';
  const userName = row.userName || raw.userName || raw.user_name || raw.name || 'Singer';
  const eventName = row.eventName || raw.eventName || raw.event_name || 'Rehearsal';
  const status = row.status || raw.status || 'present';
  const zoneId = row.zoneId || raw.zoneId || raw.zone_id || 'general';
  const checkInTime = row.checkInTime || raw.checkInTime || raw.check_in_time || raw.timestamp || raw.createdAt || raw.created_at || new Date().toISOString();
  const checkOutTime = raw.checkOutTime || raw.check_out_time || null;
  const dateString = raw.dateString || raw.date_string || (checkInTime ? new Date(checkInTime).toLocaleDateString('en-CA') : new Date().toLocaleDateString('en-CA'));
  const qrCode = row.qrCode || raw.qrCode || raw.qr_code || '';

  return {
    ...merged,
    id,
    userId,
    user_id: userId,
    userName,
    user_name: userName,
    eventName,
    event_name: eventName,
    status,
    zoneId,
    zone_id: zoneId,
    checkInTime,
    check_in_time: checkInTime,
    checkOutTime,
    check_out_time: checkOutTime,
    dateString,
    date_string: dateString,
    createdAt: checkInTime,
    created_at: checkInTime,
    timestamp: checkInTime,
    qrCode,
    qr_code: qrCode,
    rawData: raw,
  };
}

/** GET /attendance — Admin list attendance with zone and date filtering */
router.get('/', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const { zoneId, date, subGroupId } = req.query;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin';
    const effectiveZoneId = req.tenant?.effectiveZoneId !== undefined
      ? req.tenant.effectiveZoneId
      : ((zoneId && zoneId !== 'all') ? String(zoneId) : (!isHqAdmin ? (auth.zoneId as string | null) : null));
    const effectiveChurchId = req.tenant?.effectiveChurchId || (subGroupId ? String(subGroupId) : null);

    let rows: any[] = [];
    if (effectiveChurchId) {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM attendance WHERE raw_data->>'subGroupId' = $1 OR raw_data->>'sub_group_id' = $1`,
        String(effectiveChurchId),
      );
    } else if (effectiveZoneId && effectiveZoneId !== 'all') {
      const withoutHyphen = effectiveZoneId.replace(/-/g, '').toLowerCase();
      const withHyphen = effectiveZoneId.includes('-') ? effectiveZoneId.toLowerCase() : effectiveZoneId.toLowerCase().replace(/^zone(\d+)$/, 'zone-$1');

      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM attendance
         WHERE lower(replace(COALESCE(zone_id, ''), '-', '')) = $1
            OR lower(COALESCE(zone_id, '')) = $2
            OR lower(replace(COALESCE(raw_data->>'zoneId', ''), '-', '')) = $1
            OR lower(replace(COALESCE(raw_data->>'zone_id', ''), '-', '')) = $1
            OR lower(COALESCE(raw_data->>'zoneId', '')) = $2
            OR lower(COALESCE(raw_data->>'zone_id', '')) = $2`,
        withoutHyphen,
        withHyphen,
      );
    } else {
      rows = await prisma.attendance.findMany();
    }

    let data = rows.map(shapeAttendance);

    if (date) {
      data = data.filter((r) => r.dateString === date || r.checkInTime?.startsWith(String(date)));
    }

    data.sort((a, b) => String(b.checkInTime ?? '').localeCompare(String(a.checkInTime ?? '')));
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[attendance:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load attendance records' });
  }
});

/** GET /attendance/mine — Current user's records */
router.get('/mine', requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.auth.userId as string;
    const rows = await prisma.attendance.findMany({ where: { userId } });
    const data = rows.map(shapeAttendance).sort((a, b) => String(b.checkInTime ?? '').localeCompare(String(a.checkInTime ?? '')));
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[attendance/mine]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch personal attendance' });
  }
});

/** POST /attendance or POST /attendance/check-in — Singer or Admin check in */
const handleCheckIn = async (req: any, res: any) => {
  try {
    const auth = res.locals.auth;
    const requestedId = typeof req.body.id === 'string' ? req.body.id.trim() : '';
    const id = requestedId || crypto.randomUUID();
    if (id.length > 200) {
      res.status(400).json({ success: false, error: 'Attendance id is too long' });
      return;
    }
    const alreadyRecorded = await prisma.attendance.findUnique({ where: { id } });
    if (alreadyRecorded) {
      const existingRaw = (alreadyRecorded.rawData && typeof alreadyRecorded.rawData === 'object')
        ? alreadyRecorded.rawData as Record<string, any>
        : {};
      const recordedBy = (alreadyRecorded as any).recordedById || (alreadyRecorded as any).recordedByAdminId || existingRaw.recordedBy || alreadyRecorded.userId;
      if (!req.tenant?.isHQAdmin && recordedBy !== auth.userId && alreadyRecorded.userId !== auth.userId) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return;
      }
      res.status(200).json({ success: true, message: 'Attendance already recorded', data: shapeAttendance(alreadyRecorded), duplicate: true });
      return;
    }
    const now = new Date().toISOString();
    const dateString = new Date().toLocaleDateString('en-CA');

    const qrCode = String(req.body.qrCode || req.body.qr_code || '').trim();
    let targetUserId = req.body.userId || auth.userId;
    if (qrCode) {
      const qrProfileRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM profiles
         WHERE raw_data->>'qrCode' = $1 OR raw_data->>'qr_code' = $1 OR id = $1 LIMIT 1`,
        qrCode,
      );
      const qrProfile = qrProfileRows[0];
      if (!qrProfile) {
        res.status(404).json({ success: false, error: 'Singer QR code was not found.' });
        return;
      }
      targetUserId = qrProfile.id;
    }
    const userProfile = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!userProfile) {
      res.status(404).json({ success: false, error: 'Singer profile was not found.' });
      return;
    }
    const rawProfile = (userProfile?.rawData && typeof userProfile.rawData === 'object') ? (userProfile.rawData as Record<string, any>) : {};

    const requestedZone = req.body.zoneId || req.body.zone_id;
    if (!req.tenant?.isHQAdmin && requestedZone && req.tenant?.effectiveZoneId && requestedZone !== req.tenant.effectiveZoneId) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: You cannot record attendance for a zone outside your scope.',
      });
      return;
    }

    const zoneId = requestedZone || req.tenant?.effectiveZoneId || auth.zoneId || (userProfile as any).zoneId || 'general';
    const eventName = req.body.eventName?.trim() || req.body.event_name?.trim() || 'Rehearsal';
    const fullName = [userProfile.firstName || rawProfile.first_name, userProfile.lastName || rawProfile.last_name].filter(Boolean).join(' ') || userProfile.name || rawProfile.name || 'Singer';

    const rawData = {
      id,
      userId: targetUserId,
      userName: fullName,
      user_name: fullName,
      eventName,
      event_name: eventName,
      status: 'present',
      zoneId,
      zone_code: zoneId,
      dateString,
      date_string: dateString,
      checkInTime: now,
      check_in_time: now,
      voicePart: userProfile.rawData && typeof userProfile.rawData === 'object' ? (userProfile.rawData as any).voicePart || null : null,
      voice_part: userProfile.rawData && typeof userProfile.rawData === 'object' ? (userProfile.rawData as any).voice_part || null : null,
      latitude: req.body.latitude || null,
      longitude: req.body.longitude || null,
      recordedBy: auth.userId,
      createdAt: now,
    };

    const inserted = await prisma.attendance.create({
      data: {
        id,
        userId: targetUserId,
        eventName,
        status: 'present',
        organizationId: zoneId,
        checkInTime: new Date(now),
        recordedById: auth.userId,
        rawData,
      },
    });

    res.status(201).json({ success: true, message: 'Checked in successfully', data: shapeAttendance(inserted) });
  } catch (err: any) {
    console.error('[attendance:check-in]', err);
    res.status(500).json({ success: false, error: err?.message || 'Check-in failed' });
  }
};

router.post('/check-in', requireAuth, handleCheckIn);
router.post('/', requireAuth, handleCheckIn);

/** POST /attendance/check-out — Clock out */
router.post('/check-out', requireAuth, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const { attendanceId } = req.body;
    const now = new Date().toISOString();

    let existing: any = null;
    if (attendanceId) {
      existing = await prisma.attendance.findUnique({ where: { id: attendanceId } });
    } else {
      const today = new Date().toLocaleDateString('en-CA');
      const rows = await prisma.attendance.findMany({ where: { userId: auth.userId } });
      existing = rows.find((r: any) => {
        const shaped = shapeAttendance(r);
        return shaped.dateString === today && !shaped.checkOutTime;
      });
    }

    if (!existing) {
      return res.status(404).json({ success: false, error: 'No active check-in session found to check out from.' });
    }

    const raw = (existing.rawData as Record<string, any>) || {};
    const updatedRaw = {
      ...raw,
      checkOutTime: now,
      check_out_time: now,
      status: 'completed',
    };

    const updated = await prisma.attendance.update({
      where: { id: existing.id },
      data: { status: 'completed', rawData: updatedRaw },
    });

    res.json({ success: true, message: 'Checked out successfully', data: shapeAttendance(updated) });
  } catch (err: any) {
    console.error('[attendance:check-out]', err);
    res.status(500).json({ success: false, error: err?.message || 'Check-out failed' });
  }
});

/** POST /attendance/manual — Admin adds manual entry */
router.post('/manual', requireAuth, requireTenantAdmin, async (req: any, res) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'admin' || auth.role === 'zone_admin';
    if (!isHqAdmin) {
      return res.status(403).json({ success: false, error: 'Only admins can record manual attendance' });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const userName = req.body.userName?.trim() || req.body.user_name?.trim() || 'Manual Attendee';
    const eventName = req.body.eventName?.trim() || req.body.event_name?.trim() || 'Rehearsal';
    const zoneId = req.body.zoneId || auth.zoneId || 'general';
    const status = req.body.status || 'present';
    const dateString = req.body.dateString || new Date().toLocaleDateString('en-CA');

    const rawData = {
      id,
      userId: req.body.userId || `manual-${crypto.randomUUID().slice(0, 8)}`,
      userName,
      user_name: userName,
      eventName,
      event_name: eventName,
      status,
      zoneId,
      zone_id: zoneId,
      checkInTime: status === 'present' ? now : null,
      check_in_time: status === 'present' ? now : null,
      dateString,
      date_string: dateString,
      manual: true,
      recordedBy: auth.userId,
      createdAt: now,
    };

    const inserted = await prisma.attendance.create({
      data: {
        id,
        userId: rawData.userId,
        eventName,
        status,
        organizationId: zoneId,
        checkInTime: status === 'present' ? new Date(now) : null,
        recordedById: auth.userId,
        rawData,
      },
    });

    res.status(201).json({ success: true, message: 'Manual attendance recorded', data: shapeAttendance(inserted) });
  } catch (err: any) {
    console.error('[attendance:manual]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to save attendance' });
  }
});

/** PATCH /attendance/:id — Admin update attendance record */
router.patch('/:id', requireAuth, requireTenantAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { eventName, event_name, status, userName, user_name, checkInTime, check_in_time, checkOutTime, check_out_time, isArchived, is_archived } = req.body;

    const existing = await prisma.attendance.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Attendance record not found' });
    }

    const raw = (existing.rawData as Record<string, any>) || {};
    const updatedEvent = eventName || event_name || raw.eventName || (existing as any).eventName;
    const updatedUser = userName || user_name || raw.userName || (existing as any).userName;
    const updatedStatus = status !== undefined ? status : (raw.status || existing.status);
    const updatedCheckIn = checkInTime || check_in_time || raw.checkInTime || existing.checkInTime;
    const updatedCheckOut = checkOutTime !== undefined ? checkOutTime : (check_out_time !== undefined ? check_out_time : (raw.checkOutTime || null));
    const updatedArchived = isArchived !== undefined ? isArchived : (is_archived !== undefined ? is_archived : raw.isArchived);

    const updatedRaw = {
      ...raw,
      eventName: updatedEvent,
      event_name: updatedEvent,
      userName: updatedUser,
      user_name: updatedUser,
      status: updatedStatus,
      checkInTime: updatedCheckIn,
      check_in_time: updatedCheckIn,
      checkOutTime: updatedCheckOut,
      check_out_time: updatedCheckOut,
      isArchived: updatedArchived,
      is_archived: updatedArchived,
      updatedAt: new Date().toISOString(),
    };

    const updated = await prisma.attendance.update({
      where: { id },
      data: {
        eventName: updatedEvent,
        status: updatedStatus,
        rawData: updatedRaw,
      },
    });

    res.json({ success: true, message: 'Attendance record updated', data: shapeAttendance(updated) });
  } catch (err) {
    console.error('[attendance:patch]', err);
    res.status(500).json({ success: false, error: 'Failed to update attendance record' });
  }
});

/** DELETE /attendance/:id — Admin delete record */
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    await prisma.attendance.delete({ where: { id } });
    res.json({ success: true, message: 'Attendance record deleted' });
  } catch (err) {
    console.error('[attendance:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete attendance record' });
  }
});

export default router;
