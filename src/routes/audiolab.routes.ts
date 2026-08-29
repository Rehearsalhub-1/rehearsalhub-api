import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { requireAuth } from '../auth/auth.middleware';

const router = Router();

// GET /audiolab/projects
router.get('/projects', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const rows = await prisma.audioLabProject.findMany();
    const owned = rows.filter((r: any) => (r.rawData as any)?.userId === auth.userId);
    res.json({ success: true, data: owned });
  } catch (err) {
    console.error('[AudioLab] GET /projects error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /audiolab/projects
router.post('/projects', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const project = await prisma.audioLabProject.create({
      data: {
        id: crypto.randomUUID(),
        rawData: { ...req.body, userId: auth.userId, createdAt: new Date().toISOString() },
      },
    });
    res.status(201).json({ success: true, data: project });
  } catch (err) {
    console.error('[AudioLab] POST /projects error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// GET /audiolab/projects/:id
router.get('/projects/:id', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const row = await prisma.audioLabProject.findUnique({ where: { id: req.params.id } });
    if (!row) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    if ((row.rawData as any)?.userId !== auth.userId) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('[AudioLab] GET /projects/:id error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// PATCH /audiolab/projects/:id
router.patch('/projects/:id', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const row = await prisma.audioLabProject.findUnique({ where: { id: req.params.id } });
    if (!row) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    const raw = row.rawData as Record<string, any> | null;
    if (raw?.userId !== auth.userId) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    const updated = await prisma.audioLabProject.update({
      where: { id: req.params.id },
      data: { rawData: { ...raw, ...req.body, userId: auth.userId, updatedAt: new Date().toISOString() } },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[AudioLab] PATCH /projects/:id error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// DELETE /audiolab/projects/:id
router.delete('/projects/:id', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const row = await prisma.audioLabProject.findUnique({ where: { id: req.params.id } });
    if (!row) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    if ((row.rawData as any)?.userId !== auth.userId) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    await prisma.audioLabProject.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('[AudioLab] DELETE /projects/:id error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// GET /audiolab/projects/:projectId/sessions
router.get('/projects/:projectId/sessions', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const project = await prisma.audioLabProject.findUnique({ where: { id: req.params.projectId } });
    if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }
    if ((project.rawData as any)?.userId !== auth.userId) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    const rows = await prisma.audioLabSession.findMany();
    const sessions = rows.filter((s: any) => (s.rawData as any)?.projectId === req.params.projectId);
    res.json({ success: true, data: sessions });
  } catch (err) {
    console.error('[AudioLab] GET /projects/:projectId/sessions error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// POST /audiolab/projects/:projectId/sessions
router.post('/projects/:projectId/sessions', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const project = await prisma.audioLabProject.findUnique({ where: { id: req.params.projectId } });
    if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }
    if ((project.rawData as any)?.userId !== auth.userId) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    const session = await prisma.audioLabSession.create({
      data: {
        id: crypto.randomUUID(),
        rawData: { ...req.body, projectId: req.params.projectId, userId: auth.userId, createdAt: new Date().toISOString() },
      },
    });
    res.status(201).json({ success: true, data: session });
  } catch (err) {
    console.error('[AudioLab] POST /projects/:projectId/sessions error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// PATCH /audiolab/sessions/:sessionId
router.patch('/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const row = await prisma.audioLabSession.findUnique({ where: { id: req.params.sessionId } });
    if (!row) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    const raw = row.rawData as Record<string, any> | null;
    if (raw?.userId !== auth.userId) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    const updated = await prisma.audioLabSession.update({
      where: { id: req.params.sessionId },
      data: { rawData: { ...raw, ...req.body, updatedAt: new Date().toISOString() } },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[AudioLab] PATCH /sessions/:sessionId error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// DELETE /audiolab/sessions/:sessionId
router.delete('/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const auth = res.locals.auth;
    const row = await prisma.audioLabSession.findUnique({ where: { id: req.params.sessionId } });
    if (!row) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    const raw = row.rawData as Record<string, any> | null;
    if (raw?.userId !== auth.userId) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
    await prisma.audioLabSession.delete({ where: { id: req.params.sessionId } });
    res.json({ success: true });
  } catch (err) {
    console.error('[AudioLab] DELETE /sessions/:sessionId error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

export default router;
