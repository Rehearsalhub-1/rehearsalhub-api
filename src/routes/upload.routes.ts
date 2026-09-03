import { Router } from 'express';
import multer from 'multer';
import { uploadToR2, getR2Object } from '../services/r2Service';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
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

// Stream media from R2 with full HTTP Range support
router.get('/file/:key(*)', async (req, res) => {
  try {
    const key = req.params.key;
    const range = req.headers.range;
    const result = await getR2Object(key, range);

    res.setHeader('Content-Type', result.ContentType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (result.ContentRange) {
      res.status(206);
      res.setHeader('Content-Range', result.ContentRange);
    }
    if (result.ContentLength !== undefined) {
      res.setHeader('Content-Length', result.ContentLength);
    }

    (result.Body as any).pipe(res);
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).send('File not found');
    }
    console.error('[UploadRoute] Stream error:', err);
    res.status(500).send('Error streaming media');
  }
});

// Upload media directly to Cloudflare R2
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }

    const folder = (req.body.folder || 'general').toString();
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
