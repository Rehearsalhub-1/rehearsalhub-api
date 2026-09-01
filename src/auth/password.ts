import bcrypt from 'bcrypt';

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 6;

export function validatePasswordStrength(plain: string): boolean {
  return typeof plain === 'string' && plain.length >= MIN_PASSWORD_LENGTH;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
