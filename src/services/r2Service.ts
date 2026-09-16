import dotenv from 'dotenv';
dotenv.config();

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import { Readable } from 'stream';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const bucketName = process.env.R2_BUCKET_NAME || 'rehearsalhub-media';
const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
const apiBase = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const envPublicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
// If R2_PUBLIC_URL is empty or points to the private/disabled r2.dev domain, serve through the API proxy
export const publicUrlBase = (envPublicUrl && !envPublicUrl.includes('r2.dev'))
  ? envPublicUrl
  : (apiBase ? `${apiBase}/upload/file` : '/upload/file');

export const r2Client = new S3Client({
  region: 'auto',
  endpoint: accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined,
  credentials: (accessKeyId && secretAccessKey) ? {
    accessKeyId,
    secretAccessKey,
  } : undefined,
});

export interface UploadOptions {
  folder?: string;
  filename?: string;
  contentType?: string;
  cacheControl?: string;
}

function resolveMimeType(filename?: string, contentType?: string): string {
  if (contentType && contentType !== 'application/octet-stream') {
    return contentType;
  }
  const ext = (filename?.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'mp3': return 'audio/mpeg';
    case 'm4a': return 'audio/mp4';
    case 'wav': return 'audio/wav';
    case 'aac': return 'audio/aac';
    case 'webm': return 'audio/webm';
    case 'ogg': return 'audio/ogg';
    case 'flac': return 'audio/flac';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'mp4': return 'video/mp4';
    case 'mov': return 'video/quicktime';
    case 'pdf': return 'application/pdf';
    default: return contentType || 'application/octet-stream';
  }
}

export async function uploadToR2(
  fileData: Buffer | Readable,
  options: UploadOptions & { contentLength?: number } = {}
): Promise<{ url: string; key: string; size: number }> {
  const folder = (options.folder || 'general').replace(/^\/+|\/+$/g, '');
  const ext = options.filename ? options.filename.split('.').pop() : 'bin';
  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const safeFilename = options.filename
    ? `${pathSanitize(options.filename.replace(/\.[^/.]+$/, ''))}_${randomSuffix}.${ext}`
    : `${Date.now()}_${randomSuffix}.${ext}`;

  const key = folder ? `${folder}/${safeFilename}` : safeFilename;
  const finalContentType = resolveMimeType(options.filename, options.contentType);
  const size = options.contentLength ?? (Buffer.isBuffer(fileData) ? fileData.length : 0);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileData,
    ContentType: finalContentType,
    ...(size > 0 ? { ContentLength: size } : {}),
    CacheControl: options.cacheControl || 'public, max-age=31536000, immutable',
  });

  await r2Client.send(command);

  const url = `${publicUrlBase}/${key}`;
  return {
    url,
    key,
    size,
  };
}

export async function uploadToR2WithExactKey(
  fileBuffer: Buffer,
  exactKey: string,
  contentType?: string
): Promise<{ url: string; key: string; size: number }> {
  const finalContentType = resolveMimeType(exactKey, contentType);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: exactKey,
    Body: fileBuffer,
    ContentType: finalContentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });

  await r2Client.send(command);

  const url = `${publicUrlBase}/${exactKey}`;
  return {
    url,
    key: exactKey,
    size: fileBuffer.length,
  };
}

export async function deleteFromR2(key: string): Promise<boolean> {
  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    await r2Client.send(command);
    return true;
  } catch (error) {
    console.error('[R2] Error deleting object:', error);
    return false;
  }
}

export async function checkR2ObjectExists(key: string): Promise<boolean> {
  try {
    const command = new HeadObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    await r2Client.send(command);
    return true;
  } catch {
    return false;
  }
}

export async function getR2Object(key: string, range?: string) {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
    Range: range,
  });
  return await r2Client.send(command);
}

export function getR2PublicUrl(key: string): string {
  return `${publicUrlBase}/${key}`;
}

function pathSanitize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 50);
}
