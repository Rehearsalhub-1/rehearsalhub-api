import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const KINGSPAY_API_KEY = process.env.KINGSPAY_API_KEY || '';

router.post('/initialize', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!KINGSPAY_API_KEY) return res.status(503).json({ success: false, error: 'Payments are not configured on this server.' });
    const { amount, userId, type } = req.body;
    if (!amount || !userId || !type || userId !== res.locals.auth.userId) return res.status(400).json({ success: false, error: 'Missing required payment fields.' });
    res.status(501).json({ success: false, error: 'KingsPay transaction initialization is not implemented.' });
  } catch (err) {
    console.error('[kingspay/initialize]', err);
    res.status(500).json({ success: false, error: 'Failed to initialize payment.' });
  }
});

router.post('/verify', requireAuth, async (_req: Request, res: Response) => {
  res.status(501).json({ success: false, error: 'KingsPay payment verification is not implemented on this server.' });
});

router.post('/webhook', async (req: Request, res: Response) => {
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
      if (userId) {
        console.log(`[kingspay/webhook] Charge succeeded for user ${userId}`);
      }
    }

    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('[kingspay/webhook]', err);
    res.status(500).send('Internal error');
  }
});

export default router;
