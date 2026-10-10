import { Router } from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { requireAuth } from '../auth/auth.middleware';
import { r2Client, publicUrlBase } from '../services/r2Service';
import { PutObjectCommand } from '@aws-sdk/client-s3';

const router = Router();
const upload = multer({ dest: os.tmpdir() });

// Upload processed audio to R2 and return the public URL — avoids Railway egress costs.
async function uploadProcessedAudio(filePath: string, filename: string): Promise<string> {
  const key = `general/processed/${Date.now()}_${filename}`;
  const fileBuffer = fs.readFileSync(filePath);
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME || 'rehearsalhub-media',
    Key: key,
    Body: fileBuffer,
    ContentType: 'audio/mp4',
  }));
  return `${publicUrlBase}/${key}`;
}

router.post('/mix-karaoke', requireAuth, upload.single('vocals'), async (req, res) => {
  try {
    const { bgUri, startSecs, latencyMs } = req.body;
    const vocalsFile = req.file;

    if (!vocalsFile || !bgUri) {
       res.status(400).json({ success: false, error: 'Missing vocals file or bgUri' });
       return;
    }

    const latencyNum = parseInt(latencyMs || '0', 10);
    const startNum = parseInt(startSecs || '0', 10);
    const latencyPositive = Math.max(0, latencyNum);
    const latencyNegative = Math.max(0, -latencyNum);

    const outputPath = path.join(os.tmpdir(), `mix_${Date.now()}.m4a`);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .addInputOption(`-ss ${startNum}`) 
        .input(bgUri)
        .input(vocalsFile.path)
        .complexFilter([
          {
            filter: 'adelay',
            options: `${latencyPositive}|${latencyPositive}`,
            inputs: '1:a',
            outputs: 'delayed_take_pre'
          },
          {
            filter: 'volume',
            options: '8.0',
            inputs: 'delayed_take_pre',
            outputs: 'delayed_take'
          },
          {
            filter: 'adelay',
            options: `${latencyNegative}|${latencyNegative}`,
            inputs: '0:a',
            outputs: 'bg_pre'
          },
          {
            filter: 'volume',
            options: '5.0',
            inputs: 'bg_pre',
            outputs: 'bg'
          },
          {
            filter: 'amix',
            options: 'inputs=2:duration=shortest',
            inputs: ['bg', 'delayed_take'],
            outputs: 'aout_pre'
          },
          {
            filter: 'volume',
            options: '4.0',
            inputs: 'aout_pre',
            outputs: 'aout'
          }
        ])
        .outputOptions(['-map [aout]', '-y'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Upload to R2 and return URL — avoids streaming through Railway (saves egress cost)
    const mixUrl = await uploadProcessedAudio(outputPath, 'mixed_take.m4a');
    if (fs.existsSync(vocalsFile.path)) fs.unlinkSync(vocalsFile.path);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.json({ success: true, url: mixUrl });

  } catch (err) {
    console.error('[audio/mix-karaoke]', err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: 'Processing failed' });
  }
});

router.post('/bounce', requireAuth, upload.any(), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ success: false, error: 'No files provided' });
      return;
    }

    const outputPath = path.join(os.tmpdir(), `bounce_${Date.now()}.m4a`);

    if (files.length === 1) {
      await new Promise((resolve, reject) => {
        ffmpeg(files[0].path)
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
    } else {
      let command = ffmpeg();
      files.forEach(f => {
        command = command.input(f.path);
      });

      let volumes: number[] = [];
      try {
        if (req.body.volumes) volumes = JSON.parse(req.body.volumes);
      } catch (e) {}

      const filters: any[] = [];
      const amixInputs: string[] = [];

      files.forEach((_, idx) => {
        const vol = volumes[idx] !== undefined ? volumes[idx] : 1.0;
        filters.push({
          filter: 'volume',
          options: vol.toFixed(2),
          inputs: `${idx}:a`,
          outputs: `a${idx}`
        });
        amixInputs.push(`a${idx}`);
      });

      filters.push({
        filter: 'amix',
        options: `inputs=${files.length}:duration=longest`,
        inputs: amixInputs,
        outputs: 'aout'
      });

      await new Promise((resolve, reject) => {
        command
          .complexFilter(filters)
          .outputOptions(['-map [aout]', '-y'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
    }

    // Upload to R2 and return URL — avoids streaming through Railway (saves egress cost)
    const bounceUrl = await uploadProcessedAudio(outputPath, 'bounced.m4a');
    files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.json({ success: true, url: bounceUrl });

  } catch (err) {
    console.error('[audio/bounce]', err);
    if (req.files) {
      (req.files as Express.Multer.File[]).forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    }
    res.status(500).json({ success: false, error: 'Bounce failed' });
  }
});

router.post('/trim', requireAuth, upload.single('track'), async (req, res) => {
  try {
    const { keep, cutPointSec } = req.body; 
    const trackFile = req.file;

    if (!trackFile || !keep || !cutPointSec) {
      res.status(400).json({ success: false, error: 'Missing parameters' });
      return;
    }

    const outputPath = path.join(os.tmpdir(), `trim_${Date.now()}.m4a`);

    await new Promise((resolve, reject) => {
      const command = ffmpeg(trackFile.path);
      if (keep === 'left') {
        command.setDuration(parseFloat(cutPointSec));
      } else {
        command.setStartTime(parseFloat(cutPointSec));
      }
      command
        .audioCodec('copy')
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Upload to R2 and return URL — avoids streaming through Railway (saves egress cost)
    const trimUrl = await uploadProcessedAudio(outputPath, 'trimmed.m4a');
    if (fs.existsSync(trackFile.path)) fs.unlinkSync(trackFile.path);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.json({ success: true, url: trimUrl });

  } catch (err) {
    console.error('[audio/trim]', err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: 'Trim failed' });
  }
});

export default router;
