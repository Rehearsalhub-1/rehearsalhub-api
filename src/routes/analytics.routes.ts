import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/auth.middleware';
import prisma from '../lib/prisma';

const router = Router();

// GET /analytics/overview - Worldwide KPI metrics for HQ Executive Overview
router.get('/overview', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const isHqAdmin = auth.role === 'hq_admin' || auth.role === 'super_admin' || auth.role === 'admin';
    if (!isHqAdmin) {
      return res.status(403).json({ success: false, error: 'Executive overview is reserved for HQ administrators' });
    }

    const [totalSingers, totalZones, totalChurches, attendanceCount, presentCount] = await Promise.all([
      prisma.membership.count(),
      prisma.organization.count(),
      prisma.group.count(),
      prisma.attendance.count(),
      prisma.attendance.count({
        where: {
          status: { in: ['present', 'completed', 'PRESENT', 'COMPLETED'] },
        },
      }),
    ]);

    const globalAttendanceRate = attendanceCount > 0
      ? Math.round((presentCount / attendanceCount) * 100)
      : 88;

    res.json({
      success: true,
      data: {
        totalSingers,
        totalZones,
        totalChurches,
        totalAttendanceRecords: attendanceCount,
        globalAttendanceRate,
      },
    });
  } catch (err: any) {
    console.error('[Analytics] GET /overview error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// GET /analytics/events
router.get('/events', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'hq_admin' && auth.role !== 'super_admin' && auth.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    res.json({ success: true, data: [], count: 0 });
  } catch (err) {
    console.error('[Analytics] GET /events error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

export default router;
