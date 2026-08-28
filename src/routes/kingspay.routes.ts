import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';
import crypto from 'crypto';

const router = Router();
const KINGSPAY_API_KEY = process.env.KINGSPAY_API_KEY || '';

router.post('/initialize', requireAuth, async (req, res) => {
  try {
    if (!KINGSPAY_API_KEY) return res.status(503).json({ success: false, error: 'Payments are not configured on this server.' });
    const { amount, userId, userEmail, type, duration } = req.body;
    if (!amount || !userId || !type || userId !== res.locals.auth.userId) return res.status(400).json({ success: false, error: 'Missing required payment fields.' });
    res.status(501).json({ success: false, error: 'KingsPay transaction initialization is not implemented.' });
  } catch (err) {
    console.error('[kingspay/initialize]', err);
    res.status(500).json({ success: false, error: 'Failed to initialize payment.' });
  }
});

router.post('/verify', requireAuth, async (_req, res) => {
  res.status(501).json({ success: false, error: 'KingsPay payment verification is not implemented on this server.' });
});

router.post('/webhook', async (req, res) => {
  try {
    const webhookSecret = process.env.KINGSPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-kingspay-signature'];
    if (!webhookSecret || typeof signature !== 'string') return res.status(503).send('Webhook verification is not configured');
    const expected = crypto.createHmac('sha256', webhookSecret).update(JSON.stringify(req.body)).digest('hex');
    const supplied = Buffer.from(signature, 'utf8');
    const calculated = Buffer.from(expected, 'utf8');
    if (supplied.length !== calculated.length || !crypto.timingSafeEqual(supplied, calculated)) return res.status(401).send('Invalid webhook signature');

    const { event, data } = req.body;
    if (event === 'charge.success') {
      const userId = data.metadata?.userId;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);
      const profile = await prisma.profile.findUnique({ where: { id: userId } });
      if (profile) {
        const prevRaw = (profile.rawData && typeof profile.rawData === 'object') ? (profile.rawData as Record<string, any>) : {};
        const updatedSub = {
          id: `sub_${profile.id}`,
          userId: profile.id,
          plan: 'premium',
          status: 'active',
          expiresAt: expiresAt.toISOString(),
        };
        await prisma.profile.update({
          where: { id: userId },
          data: { rawData: { ...prevRaw, subscription: updatedSub } },
        });
      }
      console.log(`[kingspay/webhook] Successfully upgraded user ${userId} to premium.`);
    }

    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('[kingspay/webhook]', err);
    res.status(500).send('Webhook processing failed');
  }
});

export default router;
