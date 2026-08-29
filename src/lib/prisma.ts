import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

export type ExtendedPrismaClient = PrismaClient & {
  profile: PrismaClient['user'];
  notification: PrismaClient['broadcastNotification'];
  activityLog: PrismaClient['analyticsEvent'];
  zone: PrismaClient['organization'];
};

function createPrismaClient(): ExtendedPrismaClient {
  const connectionString = process.env.DATABASE_URL!;
  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 8000,          // shorter than Supabase's 10s kill timer
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5000,
    allowExitOnIdle: false,
  });

  // Catch transient idle socket terminations from cloud pooler (Supabase/PgBouncer)
  pool.on('error', (err) => {
    console.warn('[pg-pool] Handled idle connection drop:', err?.message || err);
  });

  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  } as any);

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'profile') return (target as any).user;
      if (prop === 'notification') return (target as any).broadcastNotification;
      if (prop === 'activityLog') return (target as any).analyticsEvent;
      if (prop === 'zone') return (target as any).organization;
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as ExtendedPrismaClient;
}

// Singleton — prevent multiple instances during hot-reload
const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };
export const prisma: ExtendedPrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
