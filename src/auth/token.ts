
import jwt, { JwtPayload, JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import crypto from 'crypto';

const secret = process.env.JWT_SECRET || 'rehearsalhub_default_secret_jwt_key_2026';
const expiresIn = process.env.JWT_EXPIRES_IN ?? '365d';

export interface AccessTokenPayload extends JwtPayload {
  sub: string;
  role: string;
  zoneId?: string;
  /** Set for church_coordinator role — the subgroup/church they administer */
  churchId?: string;
  /** Specific restricted admin screens allowed for this member (empty = unrestricted/full role) */
  adminScreens?: string[];
  jti: string;
}

export function signAccessToken(payload: {
  sub: string;
  role: string;
  zoneId?: string;
  churchId?: string;
  adminScreens?: string[];
}): string {
  if (!secret) throw new Error('JWT_SECRET is not set');
  return jwt.sign(
    {
      sub: payload.sub,
      role: payload.role,
      zoneId: payload.zoneId,
      churchId: payload.churchId,
      adminScreens: payload.adminScreens,
      jti: crypto.randomUUID(),
    },
    secret,
    { algorithm: 'HS256', expiresIn },
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  if (!secret) throw new Error('JWT_SECRET is not set');
  // throws JsonWebTokenError or TokenExpiredError on failure — never swallowed
  return jwt.verify(token, secret, { algorithms: ['HS256'] }) as AccessTokenPayload;
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

export { JsonWebTokenError, TokenExpiredError };
