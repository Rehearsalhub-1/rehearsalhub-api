import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import { uploadToR2, getR2Object } from '../services/r2Service';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${uniqueSuffix}-${file.originalname}`);
    },
  }),
  limits: {
    fileSize: 150 * 1024 * 1024, // 150 MB max per file
  },
});
const publicAvatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  },
});

// Redirect /upload/file/:key → direct Cloudflare R2 public URL.
// Previously this streamed files through Railway (causing egress costs).
// Now it returns a 301 permanent redirect to the R2 public URL.
// All app versions (old and new) automatically follow 301 redirects — zero breaking changes.
router.get('/file/:key(*)', (req, res) => {
  const key = req.params.key;
  const r2PublicBase = (process.env.R2_PUBLIC_URL || 'https://pub-cb7697578fcc48d3b3aeb70a47eb2f65.r2.dev').replace(/\/+$/, '');
  const directUrl = `${r2PublicBase}/${key}`;
  // 301 = permanent redirect — browsers and React Native cache this, further reducing requests to Railway
  res.redirect(301, directUrl);
});

// Upload media directly to Cloudflare R2
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }

    const requestedZoneId = (
      req.body.zoneId ||
      req.body.organizationId ||
      req.headers['x-zone-id'] ||
      req.headers['x-organization-id'] ||
      req.tenant?.effectiveZoneId ||
      ''
    ).toString().trim();

    const zoneId = requestedZoneId && requestedZoneId !== 'all' && requestedZoneId !== 'global'
      ? requestedZoneId
      : (req.tenant?.effectiveZoneId || 'zone-001');

    const requestedFolder = (req.body.folder || 'general').toString().replace(/^\/+|\/+$/g, '');
    const folder = `zones/${zoneId}/${requestedFolder || 'general'}`;

    const ext = file.originalname?.includes('.')
      ? file.originalname.split('.').pop()
      : (file.mimetype ? file.mimetype.split('/').pop() : 'bin');

    let resolvedFilename = (req.body.name || req.body.title || req.body.filename || file.originalname || '').toString().trim();
    if (resolvedFilename && ext && !resolvedFilename.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
      resolvedFilename = `${resolvedFilename}.${ext}`;
    }
    if (!resolvedFilename) {
      resolvedFilename = file.originalname;
    }

    const stream = fs.createReadStream(file.path);
    let result;
    try {
      result = await uploadToR2(stream, {
        folder,
        filename: resolvedFilename,
        contentType: file.mimetype,
        contentLength: file.size,
      });
    } finally {
      fs.promises.unlink(file.path).catch(() => {});
    }

    res.json({
      success: true,
      data: {
        url: result.url,
        key: result.key,
        size: result.size,
        name: resolvedFilename,
        mimeType: file.mimetype,
      },
    });
  } catch (error: any) {
    console.error('[UploadRoute] Error uploading to R2:', error);
    res.status(500).json({ success: false, error: error.message || 'Upload failed' });
  }
});

// Public upload for registration avatars if unauthenticated
router.post('/public', publicAvatarUpload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }

    const folder = 'public/avatars';
    const result = await uploadToR2(file.buffer, {
      folder,
      filename: file.originalname,
      contentType: file.mimetype,
    });

    res.json({
      success: true,
      data: {
        url: result.url,
        key: result.key,
        size: result.size,
        name: file.originalname,
        mimeType: file.mimetype,
      },
    });
  } catch (error: any) {
    console.error('[UploadRoute] Error uploading public file to R2:', error);
    res.status(500).json({ success: false, error: error.message || 'Upload failed' });
  }
});

export default router;
