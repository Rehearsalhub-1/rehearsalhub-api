import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { mergeRawRow } from '../lib/rawRow';

const router = Router();

function isoDateAfter(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rawObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

router.post('/daily-reminders', async (req, res) => {
  const configuredSecret = process.env.CRON_SECRET;
  const suppliedSecret = req.headers['x-cron-secret'];
  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const targetDate = isoDateAfter(1);
    const [eventRows, userRows] = await Promise.all([
      prisma.program.findMany(),
      prisma.user.findMany(),
    ]);

    const events = eventRows
      .map(mergeRawRow)
      .filter((event: any) => String(event.date || event.eventDate || '').slice(0, 10) === targetDate);
    const records: any[] = [];

    for (const event of events) {
      const eventZone = String(event.organizationId || event.zoneId || event.zone_id || '').toLowerCase();
      const recipients = userRows.filter((user) => {
        if (!eventZone || eventZone === 'global' || eventZone === 'all') return true;
        const raw = rawObject(user.rawData);
        const profileZone = String(raw.zoneId || raw.zone_id || raw.zoneCode || raw.zone_code || '').toLowerCase();
        return profileZone === eventZone || profileZone.replace(/-/g, '') === eventZone.replace(/-/g, '');
      });

      for (const u of recipients) {
        const id = `reminder_${crypto.createHash('sha256').update(`${event.id}:${u.id}:${targetDate}`).digest('hex').slice(0, 32)}`;
        const title = `Reminder: ${event.title || event.name || 'Upcoming event'}`;
        const message = `You have ${event.title || event.name || 'an upcoming event'} on ${targetDate}.`;
        records.push({
          id,
          title,
          body: message,
          message,
          organizationId: eventZone || null,
          senderId: 'system',
          createdAt: new Date(),
          rawData: { id, eventId: event.id, reminderDate: targetDate, generatedBy: 'daily-reminders', targetUserId: u.id },
        });
      }
    }

    if (records.length > 0) {
      for (const record of records) {
        await prisma.broadcastNotification.upsert({
          where: { id: record.id },
          update: {},
          create: record,
        });
      }
    }
    res.json({ success: true, targetDate, generatedCount: records.length });
  } catch (err) {
    console.error('[internal-cron:daily-reminders]', err);
    res.status(500).json({ success: false, error: 'Failed to generate daily reminders' });
  }
});

export default router;
