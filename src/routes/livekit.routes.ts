import { Router, Request, Response } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { requireAuth } from '../auth/auth.middleware';
import prisma from '../lib/prisma';

const router = Router();
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'rehearsalhub-livekit-key';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || process.env.JWT_SECRET || 'rehearsalhub-livekit-secret-32chars';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://rehearsal-hub-livekit.cloud';

async function generateToken(room: string, participant: string): Promise<string> {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: participant, ttl: '4h' });
  at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

async function canJoinRoom(room: string, userId: string): Promise<boolean> {
  const call = await prisma.call.findFirst({
    where: {
      OR: [
        { id: room },
        { roomId: room },
      ],
    },
  });
  if (!call) return true;
  if (call.callerId === userId || call.receiverId === userId) return true;

  if (call.chatId) {
    try {
      const chat = await prisma.chat.findUnique({
        where: { id: call.chatId },
        include: { participants: true },
      });
      if (chat && chat.participants.some((p: any) => p.userId === userId)) {
        return true;
      }
    } catch {}
  }

  return false;
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { room, participant } = req.query as { room?: string; participant?: string };
    if (!room || !participant) return res.status(400).json({ success: false, error: 'room and participant query params are required' });
    if (participant !== res.locals.auth.userId || !(await canJoinRoom(room, participant))) return res.status(403).json({ success: false, error: 'You are not a participant in this call' });
    const token = await generateToken(room, participant);
    res.json({ success: true, token, url: LIVEKIT_URL, room, participant });
  } catch (err) {
    console.error('[livekit-token:get]', err);
    res.status(500).json({ success: false, error: 'Failed to generate LiveKit token' });
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { room, participant } = req.body as { room?: string; participant?: string };
    if (!room || !participant) return res.status(400).json({ success: false, error: 'room and participant body fields are required' });
    if (participant !== res.locals.auth.userId || !(await canJoinRoom(room, participant))) return res.status(403).json({ success: false, error: 'You are not a participant in this call' });
    const token = await generateToken(room, participant);
    res.json({ success: true, token, url: LIVEKIT_URL, room, participant });
  } catch (err) {
    console.error('[livekit-token:post]', err);
    res.status(500).json({ success: false, error: 'Failed to generate LiveKit token' });
  }
});

export default router;
