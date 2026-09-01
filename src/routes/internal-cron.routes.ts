
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';

const router = Router();

function isoDateAfter(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

router.post('/daily-reminders', async (req: Request, res: Response) => {
  const configuredSecret = process.env.CRON_SECRET;
  const suppliedSecret = req.headers['x-cron-secret'];
  if (!configuredSecret || suppliedSecret !== configuredSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const targetDate = isoDateAfter(1);
    const events = await prisma.program.findMany({
      where: {
        date: targetDate,
      },
    });

    let generatedCount = 0;

    for (const event of events) {
      const orgId = event.organizationId || 'zone-001';
      const notifId = `rem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const title = `Reminder: ${event.name || 'Upcoming Rehearsal'}`;
      const message = `You have ${event.name || 'an upcoming rehearsal'} tomorrow (${targetDate}).`;

      await prisma.notification.create({
        data: {
          id: notifId,
          title,
          body: message,
          type: 'reminder',
          category: 'schedule',
          priority: 'normal',
          organizationId: orgId,
        },
      });
      generatedCount++;
    }

    res.json({ success: true, targetDate, generatedCount });
  } catch (err) {
    console.error('[internal-cron:daily-reminders]', err);
    res.status(500).json({ success: false, error: 'Failed to generate daily reminders' });
  }
});

export default router;
