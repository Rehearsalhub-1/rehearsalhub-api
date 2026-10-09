import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import crypto from 'crypto';
import { verifyAccessToken } from '../auth/token';
import { revocationStore } from '../auth/revocation';
import prisma from '../lib/prisma';

type SubscriptionKey = `${string}:${string}`;

export interface BroadcastScopeFilter {
  targetZoneId?: string | null;
  targetChurchId?: string | null;
}

interface AuthenticatedSocket extends WebSocket {
  connectionId: string;
  userId: string;
  zoneId?: string;
  churchIds?: Set<string>;
  role?: string;
  isHQ?: boolean;
}

export interface UserPresence {
  userId: string;
  isOnline: boolean;
  lastSeen: number;
}

const subscriptions = new Map<string, Set<SubscriptionKey>>();
const connections = new Map<string, AuthenticatedSocket>();
const userSocketCounts = new Map<string, number>();
const userPresenceMap = new Map<string, UserPresence>();
const eventHistory: Array<{ sequence: number; resource: string; id: string; data: unknown }> = [];
let nextEventSequence = 1;
const MAX_EVENT_HISTORY = 500;

let wss: WebSocketServer | null = null;

// ── Broadcast an event to subscribers with optional zonal/church isolation ──
export function broadcast(
  resource: string,
  id: string,
  data: unknown,
  filter?: BroadcastScopeFilter
): void {
  const event = { sequence: nextEventSequence++, resource, id, data };
  eventHistory.push(event);
  if (eventHistory.length > MAX_EVENT_HISTORY) eventHistory.shift();

  const specificKey: SubscriptionKey = `${resource}:${id}`;
  const allKey: SubscriptionKey = `${resource}:all`;

  for (const [connId, subs] of subscriptions) {
    let matches = subs.has(specificKey) || subs.has(allKey);
    
    // If the broadcast is to "all", match any subscriber of this resource
    if (!matches && id === 'all') {
      for (const sub of subs) {
        if (sub.startsWith(`${resource}:`)) {
          matches = true;
          break;
        }
      }
    }

    if (!matches) continue;
    const socket = connections.get(connId);
    if (!socket || socket.readyState !== WebSocket.OPEN) continue;

    // Apply Zonal & Church Scoping if filter is provided
    if (filter) {
      if (filter.targetChurchId) {
        const belongsToChurch = socket.churchIds?.has(filter.targetChurchId);
        if (!belongsToChurch && !socket.isHQ) {
          continue;
        }
      } else if (filter.targetZoneId && filter.targetZoneId !== 'all' && filter.targetZoneId !== 'global') {
        const normTargetZone = String(filter.targetZoneId).trim().toLowerCase();
        const normSocketZone = String(socket.zoneId || 'zone-001').trim().toLowerCase();
        if (normTargetZone !== normSocketZone && !socket.isHQ) {
          continue;
        }
      }
    }

    socket.send(JSON.stringify({ type: 'event', ...event }));
  }
}

// ── Presence Helpers ─────────────────────────────────────────────────────────
export function getUserPresence(userId: string): UserPresence {
  return userPresenceMap.get(userId) || {
    userId,
    isOnline: false,
    lastSeen: Date.now(),
  };
}

export function getAllPresence(): Record<string, UserPresence> {
  const result: Record<string, UserPresence> = {};
  for (const [userId, presence] of userPresenceMap.entries()) {
    result[userId] = presence;
  }
  return result;
}

function handleUserConnected(userId: string): void {
  const currentCount = userSocketCounts.get(userId) || 0;
  userSocketCounts.set(userId, currentCount + 1);

  const presence: UserPresence = {
    userId,
    isOnline: true,
    lastSeen: Date.now(),
  };
  userPresenceMap.set(userId, presence);

  broadcast('presence', userId, presence);
}

function handleUserDisconnected(userId: string): void {
  const currentCount = userSocketCounts.get(userId) || 1;
  const newCount = Math.max(0, currentCount - 1);
  userSocketCounts.set(userId, newCount);

  if (newCount === 0) {
    const presence: UserPresence = {
      userId,
      isOnline: false,
      lastSeen: Date.now(),
    };
    userPresenceMap.set(userId, presence);

    broadcast('presence', userId, presence);
  }
}

// ── Create and attach the WebSocket server ────────────────────────────────────
export function createWsServer(httpServer: http.Server): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (rawSocket, req) => {
    // Authenticate via ?token= query param
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      rawSocket.close(1008, 'Missing token');
      return;
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
      if (revocationStore.isRevoked(payload.jti)) {
        rawSocket.close(1008, 'Unauthorized');
        return;
      }
    } catch {
      rawSocket.close(1008, 'Unauthorized');
      return;
    }

    const socket = rawSocket as AuthenticatedSocket;
    socket.connectionId = crypto.randomUUID();
    socket.userId = payload.sub;
    socket.role = payload.role;
    socket.zoneId = payload.zoneId || 'zone-001';
    socket.isHQ = ['hq_admin', 'super_admin'].includes((payload.role || '').toLowerCase().trim());
    socket.churchIds = new Set<string>();
    if (payload.churchId) {
      socket.churchIds.add(payload.churchId);
    }

    // Populate user church/subgroup memberships asynchronously to enable scoped events
    prisma.membership.findMany({
      where: { userId: socket.userId },
      select: { organizationId: true, groupId: true },
    }).then((memberships) => {
      for (const m of memberships) {
        if (m.groupId) socket.churchIds?.add(m.groupId);
        if (m.organizationId && !socket.zoneId) socket.zoneId = m.organizationId;
      }
    }).catch(() => {});

    connections.set(socket.connectionId, socket);
    subscriptions.set(socket.connectionId, new Set());

    handleUserConnected(socket.userId);

    socket.on('message', async (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const connSubs = subscriptions.get(socket.connectionId)!;

      if (msg.type === 'subscribe' && typeof msg.resource === 'string' && typeof msg.id === 'string') {
        const chatResources = new Set(['chat', 'chats', 'messages', 'chat_deleted', 'chat_cleared', 'message_reaction', 'message_receipt']);
        const callResources = new Set(['call', 'calls', 'incoming_call', 'call_status', 'call_signal']);
        const privateResources = new Set([...chatResources, ...callResources]);
        if (privateResources.has(msg.resource) && msg.id === 'all') {
          socket.send(JSON.stringify({ type: 'error', error: 'Wildcard subscription is not allowed for private resources' }));
          return;
        }
        if (chatResources.has(msg.resource) && msg.id !== 'all') {
          const chat = await prisma.chat.findUnique({
            where: { id: msg.id },
            include: { participants: true },
          });
          const participants = Array.isArray(chat?.participants) ? chat!.participants.map((p) => p.userId) : [];
          if (!chat || (chat.createdById !== socket.userId && !participants.includes(socket.userId))) {
            socket.send(JSON.stringify({ type: 'error', error: 'Forbidden subscription' }));
            return;
          }
        }
        if (callResources.has(msg.resource) && msg.id !== 'all' && msg.id !== socket.userId) {
          const call = await prisma.call.findUnique({ where: { id: msg.id } });
          if (!call || (call.callerId !== socket.userId && call.receiverId !== socket.userId)) {
            socket.send(JSON.stringify({ type: 'error', error: 'Forbidden subscription' }));
            return;
          }
        }
        const key: SubscriptionKey = `${msg.resource}:${msg.id}`;
        connSubs.add(key);
        socket.send(JSON.stringify({ type: 'subscribed', resource: msg.resource, id: msg.id }));

        const since = Number(msg.since);
        if (Number.isFinite(since) && since > 0 && msg.resource !== 'live_song') {
          eventHistory
            .filter((event) => event.sequence > since && event.resource === msg.resource && (event.id === msg.id || msg.id === 'all'))
            .forEach((event) => socket.send(JSON.stringify({ type: 'event', ...event })));
        }

        if (msg.resource === 'presence') {
          if (msg.id === 'all') {
            socket.send(JSON.stringify({ type: 'event', resource: 'presence', id: 'all', data: getAllPresence() }));
          } else {
            socket.send(JSON.stringify({ type: 'event', resource: 'presence', id: msg.id, data: getUserPresence(msg.id) }));
          }
        }
        return;
      }

      if (msg.type === 'unsubscribe' && typeof msg.resource === 'string' && typeof msg.id === 'string') {
        const key: SubscriptionKey = `${msg.resource}:${msg.id}`;
        connSubs.delete(key);
        return;
      }

      if (msg.type === 'broadcast' && typeof msg.resource === 'string' && typeof msg.id === 'string') {
        const payload = msg.data || {};
        // Enforce Zonal and Church Isolation: live events stay strictly within sender's zone/church
        const senderZoneId = socket.zoneId || 'zone-001';
        const senderChurchId = socket.churchIds && socket.churchIds.size > 0
          ? Array.from(socket.churchIds)[0]
          : undefined;

        broadcast(msg.resource, msg.id, payload, {
          targetZoneId: senderZoneId,
          targetChurchId: senderChurchId,
        });
        return;
      }

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'set_context') {
        if (msg.zoneId && typeof msg.zoneId === 'string') {
          socket.zoneId = msg.zoneId;
        }
        if (msg.churchId && typeof msg.churchId === 'string') {
          if (!socket.churchIds) socket.churchIds = new Set();
          socket.churchIds.add(msg.churchId);
        }
        return;
      }

      if (msg.type === 'get_presence' && typeof msg.userId === 'string') {
        socket.send(JSON.stringify({
          type: 'event',
          resource: 'presence',
          id: msg.userId,
          data: getUserPresence(msg.userId),
        }));
        return;
      }

      if (msg.type === 'call:signal') {
        const targetUserId = msg.targetUserId || msg.signal?.receiverId || msg.signal?.targetUserId || msg.signal?.callerId;
        if (!targetUserId) return;

        const payload = {
          fromUserId: socket.userId,
          ...(msg.signal || msg.data || msg),
        };

        broadcast('call', targetUserId, payload);

        for (const conn of connections.values()) {
          if (conn.userId === targetUserId && conn.readyState === WebSocket.OPEN) {
            conn.send(JSON.stringify({
              type: 'event',
              resource: 'call',
              id: targetUserId,
              data: payload,
            }));
          }
        }
        return;
      }
    });

    socket.on('close', () => {
      subscriptions.delete(socket.connectionId);
      connections.delete(socket.connectionId);
      handleUserDisconnected(socket.userId);
    });

    socket.on('error', () => {
      subscriptions.delete(socket.connectionId);
      connections.delete(socket.connectionId);
      handleUserDisconnected(socket.userId);
    });
  });

  const heartbeatInterval = setInterval(() => {
    for (const [_, socket] of connections) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }
  }, 25000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return wss;
}
