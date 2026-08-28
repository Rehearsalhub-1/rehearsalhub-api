import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { requireAuth } from '../auth/auth.middleware';
import prisma from '../lib/prisma';

const router = Router();
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
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
        { rawData: { path: ['roomId'], equals: room } },
      ],
    },
  });
  if (!call) return true;
  const raw = (call.rawData && typeof call.rawData === 'object') ? (call.rawData as Record<string, any>) : {};
  const callerId = raw.callerId || raw.caller_id;
  const receiverId = raw.receiverId || raw.receiver_id;
  const participants = Array.isArray(raw.participants) ? raw.participants : [];
  return callerId === userId || receiverId === userId || participants.includes(userId);
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { room, participant } = req.query as { room?: string; participant?: string };
    if (!room || !participant) return res.status(400).json({ success: false, error: 'room and participant query params are required' });
    if (participant !== res.locals.auth.userId || !(await canJoinRoom(room, participant))) return res.status(403).json({ success: false, error: 'You are not a participant in this call' });
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return res.status(503).json({ success: false, error: 'LiveKit is not configured on this server' });
    const token = await generateToken(room, participant);
    res.json({ success: true, token, url: LIVEKIT_URL, room, participant });
  } catch (err) {
    console.error('[livekit-token:get]', err);
    res.status(500).json({ success: false, error: 'Failed to generate LiveKit token' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { room, participant } = req.body as { room?: string; participant?: string };
    if (!room || !participant) return res.status(400).json({ success: false, error: 'room and participant body fields are required' });
    if (participant !== res.locals.auth.userId || !(await canJoinRoom(room, participant))) return res.status(403).json({ success: false, error: 'You are not a participant in this call' });
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return res.status(503).json({ success: false, error: 'LiveKit is not configured on this server' });
    const token = await generateToken(room, participant);
    res.json({ success: true, token, url: LIVEKIT_URL, room, participant });
  } catch (err) {
    console.error('[livekit-token:post]', err);
    res.status(500).json({ success: false, error: 'Failed to generate LiveKit token' });
  }
});

export default router;
