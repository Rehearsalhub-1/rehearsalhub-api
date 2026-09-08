import { Router, Request, Response } from 'express';
import { requireAuth, requireTenantAdmin } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';
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

const DEFAULT_SCHEDULES: ScheduleProgram[] = [
  {
    id: 'schedule_hslhs_2026',
    name: 'JULY HSLHS 2026',
    date: '2026-07-24',
    category: 'schedule',
    status: 'ongoing',
    organizationId: 'zone-001',
    zoneId: 'zone-001',
    isCurrent: true,
    isArchived: false,
    currentWeekId: 'week_1',
    currentDayId: 'day_1',
    weeks: [
      { id: 'week_1', name: 'Week 1' },
      { id: 'week_2', name: 'Week 2' }
    ],
    days: [
      { id: 'day_1', weekId: 'week_1', name: 'Day 1' },
      { id: 'day_2', weekId: 'week_1', name: 'Day 2' },
      { id: 'day_3', weekId: 'week_2', name: 'Day 1' }
    ],
    dailySchedules: [
      { id: 'slot_1', weekId: 'week_1', dayId: 'day_1', time: '09:00', title: 'Opening Prayer & Vocal Warmup', key: '—', allotment: 15, status: 'rehearsed', note: 'Vocal warmups with Sis Grace' },
      { id: 'slot_2', weekId: 'week_1', dayId: 'day_1', time: '09:15', title: 'Lord You Are Awesome', key: 'E', allotment: 20, status: 'rehearsed', note: 'Bridge dynamic lift, check horns' },
      { id: 'slot_3', weekId: 'week_1', dayId: 'day_1', time: '09:35', title: 'Everlasting King', key: 'G', allotment: 25, status: 'not-rehearsed', note: 'Tenors enter on 2nd verse' },
      { id: 'slot_4', weekId: 'week_1', dayId: 'day_1', time: '10:00', title: 'Refreshment Break', key: '—', allotment: 15, status: 'break', note: 'Short vocal rest' },
      { id: 'slot_5', weekId: 'week_1', dayId: 'day_1', time: '10:15', title: 'We Exalt Your Name', key: 'C', allotment: 20, status: 'not-rehearsed', note: 'Full band modulation to D' },
      { id: 'slot_6', weekId: 'week_1', dayId: 'day_1', time: '10:35', title: 'You Are The Living God', key: 'F#', allotment: 25, status: 'not-rehearsed', note: 'Harmonies on chorus' }
    ],
    newSongs: [
      { id: 'new_1', title: 'Grace Abounding', key: 'Ab', duration: '5:20', submittedBy: 'Bro Daniel', submittedOn: '2026-08-10' },
      { id: 'new_2', title: 'Living Sacrifice', key: 'D', duration: '4:45', submittedBy: 'Sis Sarah', submittedOn: '2026-08-12' }
    ],
    carriedOver: [
      { id: 'co_1', title: 'Victory Chant', rehearsalCount: 2, originalProgram: 'June Praise Festival', key: 'Bb', reason: 'Need more polish on outro' },
      { id: 'co_2', title: 'Ancient of Days', rehearsalCount: 1, originalProgram: 'Mid-Year Service', key: 'C', reason: 'Arrangement modified with strings' }
    ],
    swapped: [
      { id: 'sw_1', original: 'Lift Up Your Heads', replacement: 'King of Kings', swappedBy: 'Music Director', swappedOn: '2026-08-14', reason: 'Fits the service theme better' }
    ],
    nameChanges: [
      { id: 'nc_1', from: 'Song of Deliverance (Rough)', to: 'Mighty Deliverer', changedBy: 'Admin', changedOn: '2026-08-15', reason: 'Official title confirmed by composer' }
    ],
    invalidSongs: [
      { id: 'inv_1', title: 'Old Anthem Demo', invalidatedBy: 'HQ Admin', replacedBy: 'Living Sacrifice', date: '2026-08-11', reason: 'Key mismatch with choir lead' }
    ],
    submitters: [
      { id: 'sub_1', name: 'Bro Daniel', role: 'Vocal Lead', submissions: 2, quota: 3, isBlocked: false },
      { id: 'sub_2', name: 'Sis Sarah', role: 'Soprano Lead', submissions: 3, quota: 3, isBlocked: false },
      { id: 'sub_3', name: 'Bro Kingsley', role: 'Choir Member', submissions: 1, quota: 2, isBlocked: true, since: '2026-08-01', reason: 'Late submissions repeatedly' }
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'schedule_midweek_2026',
    name: 'MID-WEEK REHEARSAL 2026',
    date: '2026-08-05',
    category: 'schedule',
    status: 'ongoing',
    organizationId: 'zone-001',
    zoneId: 'zone-001',
    isCurrent: false,
    isArchived: false,
    currentWeekId: 'week_1',
    currentDayId: 'day_1',
    weeks: [{ id: 'week_1', name: 'Week 1' }],
    days: [{ id: 'day_1', weekId: 'week_1', name: 'Day 1' }],
    dailySchedules: [
      { id: 'm_1', weekId: 'week_1', dayId: 'day_1', time: '17:00', title: 'Band Setup & Line Check', key: '—', allotment: 30, status: 'rehearsed', note: 'Check in-ear monitors' },
      { id: 'm_2', weekId: 'week_1', dayId: 'day_1', time: '17:30', title: 'Praise Section Medley', key: 'G', allotment: 30, status: 'not-rehearsed', note: 'Fast tempo 128bpm' }
    ],
    newSongs: [],
    carriedOver: [],
    swapped: [],
    nameChanges: [],
    invalidSongs: [],
    submitters: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'schedule_may_archive',
    name: 'MAY PRAISE CELEBRATION',
    date: '2026-05-15',
    category: 'schedule',
    status: 'archive',
    organizationId: 'zone-001',
    zoneId: 'zone-001',
    isCurrent: false,
    isArchived: true,
    currentWeekId: 'week_1',
    currentDayId: 'day_1',
    weeks: [{ id: 'week_1', name: 'Week 1' }],
    days: [{ id: 'day_1', weekId: 'week_1', name: 'Day 1' }],
    dailySchedules: [],
    newSongs: [],
    carriedOver: [],
    swapped: [],
    nameChanges: [],
    invalidSongs: [],
    submitters: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

let memorySchedules: ScheduleProgram[] = [];

function loadSchedulesFromDisk(): ScheduleProgram[] {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(SCHEDULE_FILE)) {
      const content = fs.readFileSync(SCHEDULE_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
    // Write defaults
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(DEFAULT_SCHEDULES, null, 2), 'utf8');
    return [...DEFAULT_SCHEDULES];
  } catch (err) {
    console.error('[schedule.routes] Error loading schedules from disk:', err);
    return [...DEFAULT_SCHEDULES];
  }
}

function saveSchedulesToDisk(items: ScheduleProgram[]) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(items, null, 2), 'utf8');
  } catch (err) {
    console.error('[schedule.routes] Error saving schedules to disk:', err);
  }
}

// Initial load
memorySchedules = loadSchedulesFromDisk();

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
    organizationId: p.organizationId || p.zoneId || 'zone-001',
    zoneId: p.zoneId || p.organizationId || 'zone-001',
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
    const { zoneId, subGroupId, isArchived } = req.query as {
      zoneId?: string;
      subGroupId?: string;
      isArchived?: string;
    };

    let list = [...memorySchedules];

    if (subGroupId) {
      list = list.filter(p => p.subGroupId === subGroupId);
    } else if (zoneId && zoneId !== 'all' && zoneId !== 'global') {
      list = list.filter(p => p.zoneId === zoneId || p.organizationId === zoneId || p.zoneId === 'zone-001');
    }

    if (isArchived !== undefined) {
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
    const orgId = req.body.zoneId || req.tenant?.effectiveZoneId || 'zone-001';
    const subGroupId = req.body.subGroupId || undefined;

    const newWeekId = `week_${Date.now()}`;
    const newDayId = `day_${Date.now()}`;

    const newProgram: ScheduleProgram = {
      id,
      name,
      date,
      category: 'schedule',
      status: 'ongoing',
      organizationId: orgId,
      zoneId: orgId,
      subGroupId,
      isCurrent: false,
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

    memorySchedules = [newProgram, ...memorySchedules];
    saveSchedulesToDisk(memorySchedules);

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
        if (p.id !== scheduleId && (p.zoneId === current.zoneId || p.organizationId === current.organizationId)) {
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
    saveSchedulesToDisk(memorySchedules);

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
      saveSchedulesToDisk(memorySchedules);
      broadcast('schedule', 'all', { type: 'delete', scheduleId });
    }

    res.json({ success: true, message: 'Schedule program deleted' });
  } catch (err) {
    console.error('[schedule:delete]', err);
    res.status(500).json({ success: false, error: 'Failed to delete schedule' });
  }
});

export default router;
