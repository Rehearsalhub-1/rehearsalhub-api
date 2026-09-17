import { Router, Request, Response } from 'express';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';
import prisma from '../lib/prisma';
import fs from 'fs';
import path from 'path';

const router = Router();

const DATA_DIR = path.join(__dirname, '../../data');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedules.json');

interface ScheduleProgram {
  id: string;
  name: string;
  date?: string;
  category?: string;
  status?: string;
  organizationId?: string;
  zoneId?: string;
  subGroupId?: string;
  isCurrent?: boolean;
  isArchived?: boolean;
  currentWeekId?: string;
  currentDayId?: string;
  weeks?: { id: string; name: string }[];
  days?: { id: string; weekId: string; name: string }[];
  dailySchedules?: {
    id: string;
    weekId?: string;
    dayId?: string;
    time: string;
    title: string;
    key?: string;
    allotment: number | string;
    status: 'rehearsed' | 'not-rehearsed' | 'break';
    note?: string;
  }[];
  newSongs?: {
    id: string;
    title: string;
    key?: string;
    duration?: string;
    submittedBy?: string;
    submittedOn?: string;
  }[];
  carriedOver?: {
    id: string;
    title: string;
    rehearsalCount?: number;
    originalProgram?: string;
    key?: string;
    reason?: string;
  }[];
  swapped?: {
    id: string;
    original: string;
    replacement: string;
    swappedBy?: string;
    swappedOn?: string;
    reason?: string;
  }[];
  nameChanges?: {
    id: string;
    from: string;
    to: string;
    changedBy?: string;
    changedOn?: string;
    reason?: string;
  }[];
  invalidSongs?: {
    id: string;
    title: string;
    invalidatedBy?: string;
    replacedBy?: string;
    date?: string;
    reason?: string;
  }[];
  submitters?: {
    id: string;
    name: string;
    role?: string;
    submissions?: number;
    quota?: number;
    isBlocked?: boolean;
    since?: string;
    reason?: string;
  }[];
  createdAt?: string;
  updatedAt?: string;
}

const DEFAULT_SCHEDULES: ScheduleProgram[] = [];

let memorySchedules: ScheduleProgram[] = [];

function loadSchedulesFromDisk(): ScheduleProgram[] {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(SCHEDULE_FILE)) {
      const content = fs.readFileSync(SCHEDULE_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        // Strip out any legacy hardcoded mock schedules
        const filtered = parsed.filter(p => !p.id?.startsWith('schedule_hslhs_') && !p.id?.startsWith('schedule_midweek_') && !p.id?.startsWith('schedule_may_archive'));
        return filtered;
      }
    }
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify([], null, 2), 'utf8');
    return [];
  } catch (err) {
    console.error('[schedule.routes] Error loading schedules from disk:', err);
    return [];
  }
}

async function saveSchedulesToDisk(items: ScheduleProgram[]): Promise<void> {
  memorySchedules = items;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(items, null, 2), 'utf8');
  } catch (err) {
    console.error('[schedule.routes] Error saving schedules to disk:', err);
  }

  // Durable primary backup to PostgreSQL settings table
  try {
    await prisma.setting.upsert({
      where: { key: 'rehearsal_schedules_backup' },
      update: { value: { schedules: items as any } },
      create: { key: 'rehearsal_schedules_backup', value: { schedules: items as any } },
    });
  } catch (err: any) {
    console.warn('[schedule.routes] DB backup error:', err?.message);
  }
}

// Initial load
memorySchedules = loadSchedulesFromDisk();
loadSchedulesWithDbFallback().catch(console.error);

async function loadSchedulesWithDbFallback(): Promise<void> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'rehearsal_schedules_backup' } });
    if (row && typeof row.value === 'object' && Array.isArray((row.value as any)?.schedules) && (row.value as any).schedules.length > 0) {
      memorySchedules = (row.value as any).schedules;
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(memorySchedules, null, 2), 'utf8');
      } catch {}
      return;
    }
  } catch {}
  if (memorySchedules.length === 0) {
    memorySchedules = loadSchedulesFromDisk();
  }
}

function shapeFullSchedule(p: ScheduleProgram) {
  const weeks = Array.isArray(p.weeks) && p.weeks.length > 0
    ? p.weeks
    : [{ id: 'default_week_1', name: 'Week 1' }];

  const days = Array.isArray(p.days) && p.days.length > 0
    ? p.days
    : [{ id: 'default_day_1', weekId: weeks[0]?.id || 'default_week_1', name: 'Day 1' }];

  return {
    id: p.id,
    name: p.name,
    date: p.date || new Date().toISOString().split('T')[0],
    category: p.category || 'schedule',
    status: p.status || (p.isArchived ? 'archive' : 'ongoing'),
    organizationId: p.organizationId || p.zoneId || '',
    zoneId: p.zoneId || p.organizationId || '',
    subGroupId: p.subGroupId || null,
    isCurrent: Boolean(p.isCurrent),
    isArchived: Boolean(p.isArchived),
    currentWeekId: p.currentWeekId || weeks[0]?.id || 'default_week_1',
    currentDayId: p.currentDayId || days[0]?.id || 'default_day_1',
    weeks,
    days,
    dailySchedules: Array.isArray(p.dailySchedules) ? p.dailySchedules : [],
    newSongs: Array.isArray(p.newSongs) ? p.newSongs : [],
    carriedOver: Array.isArray(p.carriedOver) ? p.carriedOver : [],
    swapped: Array.isArray(p.swapped) ? p.swapped : [],
    nameChanges: Array.isArray(p.nameChanges) ? p.nameChanges : [],
    invalidSongs: Array.isArray(p.invalidSongs) ? p.invalidSongs : [],
    submitters: Array.isArray(p.submitters) ? p.submitters : [],
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || new Date().toISOString(),
  };
}

// ── GET /schedules or /schedule ─────────────────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    if (memorySchedules.length === 0) {
      await loadSchedulesWithDbFallback();
    }

    const { zoneId, subGroupId, isArchived } = req.query as {
      zoneId?: string;
      subGroupId?: string;
      isArchived?: string;
    };

    const cleanZoneId = zoneId && zoneId !== 'all' ? zoneId.trim() : '';
    const cleanSubGroupId = subGroupId && subGroupId !== 'all' ? subGroupId.trim() : '';

    const effectiveZoneId = cleanZoneId || req.tenant?.effectiveZoneId || '';
    // If client explicitly passed subGroupId as empty string, treat as no church filter
    const effectiveChurchId = cleanSubGroupId || (cleanSubGroupId === '' && req.query.subGroupId !== undefined ? '' : (req.tenant?.effectiveChurchId || ''));

    let list = [...memorySchedules];

    // Purge any lingering legacy mock IDs
    list = list.filter(p => !p.id?.startsWith('schedule_hslhs_') && !p.id?.startsWith('schedule_midweek_') && !p.id?.startsWith('schedule_may_archive'));

    // 1. Church-specific filter: If scoped to a church
    if (effectiveChurchId && effectiveChurchId !== 'all') {
      const churchSpecific = list.filter(p => p.subGroupId === effectiveChurchId);
      if (churchSpecific.length > 0) {
        list = churchSpecific;
      } else {
        // Fallback to zone schedules for church singers if church hasn't made a dedicated schedule
        list = list.filter(p => !p.subGroupId);
      }
    } else {
      // By default for zone schedule view, show non-church-specific schedules
      const mainList = list.filter(p => !p.subGroupId);
      if (mainList.length > 0) {
        list = mainList;
      }
    }

    // 2. Zone scoping
    if (effectiveZoneId && effectiveZoneId !== 'all') {
      list = list.filter(p => p.zoneId === effectiveZoneId || p.organizationId === effectiveZoneId);
    }

    if (isArchived !== undefined && isArchived !== '') {
      const archBool = isArchived === 'true';
      list = list.filter(p => Boolean(p.isArchived) === archBool);
    }

    res.json({
      success: true,
      count: list.length,
      data: list.map(shapeFullSchedule),
    });
  } catch (err) {
    console.error('[schedule:get]', err);
    res.status(500).json({ success: false, error: 'Failed to load schedules' });
  }
});


// ── GET /schedules/:scheduleId ──────────────────────────────────────────────
router.get('/:scheduleId', requireAuth, async (req: Request, res: Response) => {
  try {
    await loadSchedulesWithDbFallback();
    const item = memorySchedules.find(p => p.id === req.params.scheduleId);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Schedule program not found' });
    }
    res.json({ success: true, data: shapeFullSchedule(item) });
  } catch (err) {
    console.error('[schedule:get:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load schedule' });
  }
});

// ── POST /schedules ─────────────────────────────────────────────────────────
router.post('/', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const id = req.body.id || `schedule_${Date.now()}`;
    const name = (req.body.name || req.body.title || 'Rehearsal Schedule').trim();
    const date = req.body.date || now.toISOString().split('T')[0];
    const orgId = (req.body.zoneId || req.body.organizationId || req.tenant?.effectiveZoneId || '').trim();
    const subGroupId = req.body.subGroupId ? String(req.body.subGroupId).trim() : undefined;

    const newWeekId = `week_${Date.now()}`;
    const newDayId = `day_${Date.now()}`;

    // Auto-make current if first active schedule in this zone or explicitly requested
    const hasActiveCurrentInZone = memorySchedules.some(p =>
      Boolean(p.isCurrent) &&
      !p.isArchived &&
      ((p.zoneId && orgId && p.zoneId === orgId) || (p.organizationId && orgId && p.organizationId === orgId) || (!p.zoneId && !orgId))
    );
    const shouldBeCurrent = req.body.isCurrent !== undefined ? Boolean(req.body.isCurrent) : !hasActiveCurrentInZone;

    const newProgram: ScheduleProgram = {
      id,
      name,
      date,
      category: 'schedule',
      status: 'ongoing',
      organizationId: orgId,
      zoneId: orgId,
      subGroupId,
      isCurrent: shouldBeCurrent,
      isArchived: false,
      currentWeekId: newWeekId,
      currentDayId: newDayId,
      weeks: req.body.weeks || [{ id: newWeekId, name: 'Week 1' }],
      days: req.body.days || [{ id: newDayId, weekId: newWeekId, name: 'Day 1' }],
      dailySchedules: req.body.dailySchedules || [],
      newSongs: req.body.newSongs || [],
      carriedOver: req.body.carriedOver || [],
      swapped: req.body.swapped || [],
      nameChanges: req.body.nameChanges || [],
      invalidSongs: req.body.invalidSongs || [],
      submitters: req.body.submitters || [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (shouldBeCurrent) {
      memorySchedules = memorySchedules.map(p => {
        const sameZone = (p.zoneId && orgId && p.zoneId === orgId) || (p.organizationId && orgId && p.organizationId === orgId) || (!p.zoneId && !orgId);
        if (sameZone) {
          return { ...p, isCurrent: false };
        }
        return p;
      });
    }

    memorySchedules = [newProgram, ...memorySchedules];
    await saveSchedulesToDisk(memorySchedules);

    const shaped = shapeFullSchedule(newProgram);
    broadcast('schedule', 'all', { type: 'create', data: shaped });

    res.status(201).json({
      success: true,
      message: 'Schedule program created',
      data: shaped,
    });
  } catch (err: any) {
    console.error('[schedule:create]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to create schedule' });
  }
});

// ── PATCH /schedules/:scheduleId ────────────────────────────────────────────
router.patch('/:scheduleId', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { scheduleId } = req.params;
    const index = memorySchedules.findIndex(p => p.id === scheduleId);
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Schedule program not found' });
    }

    const current = memorySchedules[index];

    // If making this schedule current, unmark others in this zone
    if (req.body.isCurrent === true) {
      memorySchedules = memorySchedules.map(p => {
        const sameZone = (p.zoneId && current.zoneId && p.zoneId === current.zoneId) || (p.organizationId && current.organizationId && p.organizationId === current.organizationId) || (!p.zoneId && !current.zoneId);
        if (p.id !== scheduleId && sameZone) {
          return { ...p, isCurrent: false };
        }
        return p;
      });
    }

    const updated: ScheduleProgram = {
      ...current,
      ...req.body,
      updatedAt: new Date().toISOString(),
    };

    memorySchedules[index] = updated;
    await saveSchedulesToDisk(memorySchedules);

    const shaped = shapeFullSchedule(updated);
    broadcast('schedule', 'all', { type: 'update', data: shaped });

    res.json({
      success: true,
      message: 'Schedule updated',
      data: shaped,
    });
  } catch (err: any) {
    console.error('[schedule:patch]', err);
    res.status(500).json({ success: false, error: err?.message || 'Failed to update schedule' });
  }
});

// ── DELETE /schedules/:scheduleId ───────────────────────────────────────────
router.delete('/:scheduleId', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { scheduleId } = req.params;
    const prevLen = memorySchedules.length;
    memorySchedules = memorySchedules.filter(p => p.id !== scheduleId);

    if (memorySchedules.length !== prevLen) {
      await saveSchedulesToDisk(memorySchedules);
      broadcast('schedule', 'all', { type: 'delete', scheduleId });
    }

    res.json({ success: true, message: 'Schedule program deleted' });
  } catch (err) {
    console.error('[schedule:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete schedule' });
  }
});

export default router;
