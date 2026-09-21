import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth, requireTenantAdmin, optionalAuth } from '../auth/auth.middleware';
import { broadcast } from '../ws/wsServer';

const router = Router();

function resolveAudio(song: any): { audioUrl: string; audioUrls: Record<string, string> } {
  const urlsObj: Record<string, string> = {};
  if (song.audioUrls && typeof song.audioUrls === 'object' && !Array.isArray(song.audioUrls)) {
    Object.assign(urlsObj, song.audioUrls);
  }
  if (song.audio_urls && typeof song.audio_urls === 'object' && !Array.isArray(song.audio_urls)) {
    Object.assign(urlsObj, song.audio_urls);
  }
  if (song.sopranoUrl || song.soprano_url) urlsObj.soprano = song.sopranoUrl || song.soprano_url;
  if (song.altoUrl || song.alto_url) urlsObj.alto = song.altoUrl || song.alto_url;
  if (song.tenorUrl || song.tenor_url) urlsObj.tenor = song.tenorUrl || song.tenor_url;
  if (song.bassUrl || song.bass_url) urlsObj.bass = song.bassUrl || song.bass_url;
  if (song.leadVocalUrl || song.lead_vocal_url) urlsObj.lead = song.leadVocalUrl || song.lead_vocal_url;
  if (song.instrumentalUrl || song.instrumental_url) urlsObj.instrumental = song.instrumentalUrl || song.instrumental_url;

  const audio =
    song.audioFile ||
    song.audio_file ||
    song.audioUrl ||
    song.audio_url ||
    song.url ||
    urlsObj.full ||
    urlsObj.main ||
    urlsObj.master ||
    urlsObj.lead ||
    urlsObj.soprano ||
    urlsObj.tenor ||
    urlsObj.alto ||
    (Object.values(urlsObj).find((v: any) => typeof v === 'string' && v.trim().length > 0) as string) ||
    '';

  if (audio && !urlsObj.full) {
    urlsObj.full = audio;
  }

  return { audioUrl: audio, audioUrls: urlsObj };
}

function formatSong(song: any) {
  return shapeSong(song);
}
function isConductorGuideText(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('harmony') ||
    lower.includes('harmonies') ||
    lower.includes('unison') ||
    lower.includes('verse 1') ||
    lower.includes('verse 2') ||
    lower.includes('modulate') ||
    lower.includes('modulation') ||
    lower.includes('coda') ||
    lower.includes('refrain') ||
    lower.includes('prechorus') ||
    lower.includes('pre-chorus') ||
    lower.includes('turnaround') ||
    lower.includes('interlude') ||
    (lower.includes('<div') && lower.includes('solo'))
  );
}

function shapeSong(song: any) {
  const { audioUrl, audioUrls } = resolveAudio(song);

  // Extract primary program info from relation if populated
  const programSongs = song.programSongs || [];
  const primaryProgramSong = programSongs.length > 0 ? programSongs[0] : null;
  const primaryProgram = primaryProgramSong?.program || null;
  const programId = primaryProgram?.id || song.programId || null;
  const programName = primaryProgram?.name || song.program || null;

  const rawSolfas = song.solfas || '';
  const rawConductor = song.conductor || '';
  const rawConductorGuide = song.conductorGuide || '';

  const isGuideInSolfas = isConductorGuideText(rawSolfas);
  const resolvedConductorGuide = isGuideInSolfas ? rawSolfas : (rawConductorGuide || (isConductorGuideText(rawConductor) ? rawConductor : ''));
  const resolvedConductorPerson = isConductorGuideText(rawConductor) ? '' : rawConductor;
  const resolvedSolfa = isGuideInSolfas ? '' : rawSolfas;

  const leadSingerRole = song.roleAssignments?.find(
    (r: any) => r.role === 'LEAD_SINGER' || r.role === 'lead_singer'
  );
  let resolvedLeadSinger = song.leadSinger || '';
  if (leadSingerRole?.user) {
    const u = leadSingerRole.user;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.email;
    if (name) resolvedLeadSinger = name;
  }
  if (!resolvedLeadSinger) resolvedLeadSinger = 'Loveworld Singers';

  const historySummary = programName
    ? `**Ministered at ${programName}**\n\n- **Lead Singer:** ${resolvedLeadSinger}\n- **Conductor:** ${resolvedConductorPerson || '—'}\n- **Key:** ${song.key || '—'} · **Tempo:** ${song.tempo || '—'}\n- **Rehearsal Count:** x${song.rehearsalCount || 0}`
    : (song.createdAt ? `**Catalog Entry**\n\n- **Lead Singer:** ${resolvedLeadSinger}\n- **Key:** ${song.key || '—'}` : '');

  return {
    id: song.id,
    praiseNightId: programId,
    programId: programId,
    program: programName,
    programName: programName,
    programBannerImage: primaryProgram?.bannerImage || null,
    order: song.order !== undefined ? song.order : (primaryProgramSong?.order ?? null),
    title: song.title || 'Untitled Song',
    key: song.key || null,
    tempo: song.tempo || null,
    lyrics: song.lyrics || '',
    karaokeLrcText: song.lyrics || '',
    lrcText: song.lyrics || '',
    syncedLyricsText: song.lyrics || '',
    solfas: resolvedSolfa,
    solfa: resolvedSolfa,
    writer: song.writer || '',
    leadSinger: resolvedLeadSinger,
    conductor: resolvedConductorPerson,
    conductorGuide: resolvedConductorGuide,
    drummer: song.drummer || '',
    leadKeyboardist: song.leadKeyboardist || '',
    leadGuitarist: song.leadGuitarist || '',
    bassGuitarist: song.bassGuitarist || '',
    audioFile: audioUrl,
    audioUrl: audioUrl,
    audioUrls: Object.keys(audioUrls).length > 0 ? audioUrls : (audioUrl ? { full: audioUrl } : null),
    imageUrl: song.imageUrl || (song as any).image_url || null,
    image: song.imageUrl || (song as any).image_url || null,
    category: song.category || null,
    status: song.status || 'active',
    isMaster: Boolean(song.isMaster),
    isMinistered: Boolean(song.isMinistered),
    isHQOnly: Boolean(song.status === 'hq_only' || (song.audioUrls as any)?._isHQOnly || (song as any).isHQOnly || (song as any).isHqOnly),
    is_hq_only: Boolean(song.status === 'hq_only' || (song.audioUrls as any)?._isHQOnly || (song as any).isHQOnly || (song as any).isHqOnly),
    isHqOnly: Boolean(song.status === 'hq_only' || (song.audioUrls as any)?._isHQOnly || (song as any).isHQOnly || (song as any).isHqOnly),
    scope: (song.status === 'hq_only' || (song.audioUrls as any)?._isHQOnly) ? 'hq' : 'global',
    rehearsalCount: Math.max(0, parseInt((song.rehearsalCount ?? (song as any).rehearsal_count) as any, 10) || 0),
    organizationId: song.organizationId || null,
    groupId: song.groupId || null,
    isActive: Boolean(song.status === 'live' && song.isActive !== false),
    isLive: Boolean(song.status === 'live' && song.isActive !== false),
    ...(() => {
      let commentsList: any[] = [];
      const rawComments = song.comments;
      if (Array.isArray(rawComments)) {
        commentsList = rawComments;
      } else if (typeof rawComments === 'string' && rawComments.trim().length > 0) {
        const trimmed = rawComments.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            commentsList = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            commentsList = [{ id: `comment-${song.id}`, text: trimmed, date: song.updatedAt || song.createdAt, author: 'Coordinator' }];
          }
        } else {
          commentsList = [{ id: `comment-${song.id}`, text: trimmed, date: song.updatedAt || song.createdAt, author: 'Coordinator' }];
        }
      }

      if (commentsList.length === 0 && song.notes) {
        commentsList = [{ id: `comment-${song.id}`, text: song.notes, date: song.updatedAt || song.createdAt, author: 'Coordinator' }];
      }

      const latestComment = commentsList.length > 0 ? commentsList[commentsList.length - 1] : null;
      const commentText = song.notes || (latestComment ? (typeof latestComment === 'string' ? latestComment : (latestComment.text || latestComment.comment || latestComment.content || '')) : '');
      const commentAudio = latestComment?.audioUrl || (song as any).coordinatorAudioUrl || '';

      return {
        comments: commentsList,
        notes: commentText,
        coordinatorComment: commentText,
        coordinatorAudioUrl: commentAudio,
      };
    })(),
    createdAt: song.createdAt,
    updatedAt: song.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MASTER SONGS ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
const getMinisteredSongsHandler = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limitParam = req.query.limit ? parseInt(req.query.limit as string) : (req.query.page ? 50 : 1000);
    const limit = Math.min(2000, Math.max(1, isNaN(limitParam) ? 1000 : limitParam));
    const search = ((req.query.search as string) || '').trim();
    const skip = (page - 1) * limit;

    const auth = res.locals.auth || (req as any).user || {};
    const isHqUser = Boolean(req.tenant?.isHQAdmin || auth.role === 'hq_admin' || auth.role === 'super_admin' || auth.role === 'admin' || auth.hasHqAccess || auth.has_hq_access);

    const where: any = { isMaster: true };
    if (!isHqUser) {
      where.status = { not: 'hq_only' };
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { writer: { contains: search, mode: 'insensitive' } },
        { leadSinger: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
        { lyrics: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
        { comments: { contains: search, mode: 'insensitive' } },
        { solfas: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.song.count({ where }),
      prisma.song.findMany({
        where,
        include: {
          roleAssignments: { include: { user: true } },
          programSongs: {
            include: {
              program: {
                select: { id: true, name: true, bannerImage: true }
              }
            },
            take: 1
          }
        },
        orderBy: { title: 'asc' },
        skip,
        take: limit
      }),
    ]);

    const formatted = rows
      .filter(r => isHqUser || (r.status !== 'hq_only' && !(r.audioUrls as any)?._isHQOnly))
      .map(formatSong);
    res.json({
      success: true,
      count: formatted.length,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: formatted,
    });
  } catch (err) {
    console.error('[songs/master]', err);
    res.status(500).json({ success: false, error: 'Failed to load master songs' });
  }
};

function stripHtmlText(html: string): string {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChatSnippet(fullText: string, targetQuery: string, targetWords: string[]): string {
  const lower = fullText.toLowerCase();
  let idx = -1;
  let foundWord = targetQuery;

  idx = lower.indexOf(targetQuery.toLowerCase());
  if (idx === -1) {
    const noPunctFull = fullText.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’]/g, ' ').replace(/\s+/g, ' ');
    const qClean = targetQuery.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’]/g, ' ').replace(/\s+/g, ' ');
    const pIdx = noPunctFull.indexOf(qClean);
    if (pIdx !== -1) {
      idx = Math.min(pIdx, fullText.length - 1);
    }
  }

  if (idx === -1 && targetWords.length > 0) {
    for (const w of targetWords) {
      if (w.length < 2) continue;
      const i = lower.indexOf(w);
      if (i !== -1 && (idx === -1 || i < idx)) {
        idx = i;
        foundWord = w;
      }
    }
  }

  if (idx === -1) return '';

  const start = Math.max(0, idx - 26);
  const end = Math.min(fullText.length, idx + foundWord.length + 42);
  let snippet = fullText.slice(start, end).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < fullText.length) snippet = snippet + '...';
  return snippet;
}

// Universal Search across ALL songs in the database (master catalog, ministered programs, zone songs)
const universalSearchHandler = async (req: Request, res: Response) => {
  try {
    const rawQ = String(req.query.q || req.query.query || req.query.search || '').trim();
    if (!rawQ) {
      return res.json({ success: true, count: 0, data: [] });
    }

    const limitParam = req.query.limit ? parseInt(req.query.limit as string) : 60;
    const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 60 : limitParam));
    const cleanQ = rawQ.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').trim();
    const queryWords = cleanQ.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’]/g, ' ').split(/\s+/).filter(w => w.length > 0);

    const orConditions: any[] = [
      { title: { contains: cleanQ, mode: 'insensitive' } },
      { lyrics: { contains: cleanQ, mode: 'insensitive' } },
      { writer: { contains: cleanQ, mode: 'insensitive' } },
      { leadSinger: { contains: cleanQ, mode: 'insensitive' } },
      { category: { contains: cleanQ, mode: 'insensitive' } },
      { notes: { contains: cleanQ, mode: 'insensitive' } },
      { comments: { contains: cleanQ, mode: 'insensitive' } },
      { solfas: { contains: cleanQ, mode: 'insensitive' } },
    ];

    if (queryWords.length > 1) {
      orConditions.push({
        AND: queryWords.map(word => ({
          OR: [
            { title: { contains: word, mode: 'insensitive' } },
            { lyrics: { contains: word, mode: 'insensitive' } },
            { writer: { contains: word, mode: 'insensitive' } },
            { leadSinger: { contains: word, mode: 'insensitive' } },
          ]
        }))
      });
    }

    const auth = res.locals.auth || (req as any).user || {};
    const role = (auth.role || '').toLowerCase();
    const isHQOrPresident = Boolean(
      req.tenant?.isHQAdmin ||
      ['president', 'director', 'oftp', 'executive', 'hq_admin', 'admin', 'super_admin', 'boss'].includes(role) ||
      auth.hasHqAccess ||
      auth.has_hq_access
    );

    const requestedZoneId = String(req.query.zoneId || req.query.zone_id || '').trim();
    const effectiveZoneId = (req.tenant?.effectiveZoneId || auth.zoneId || requestedZoneId || '').trim();

    // ── 1. Assigned Zone & Master/Ministered isolation (NEVER search all zones!) ──
    const andConditions: any[] = [{ OR: orConditions }];

    if (effectiveZoneId) {
      andConditions.push({
        OR: [
          { isMaster: true },
          { isMinistered: true },
          { organizationId: null },
          { organizationId: effectiveZoneId },
        ]
      });
    } else {
      andConditions.push({
        OR: [
          { isMaster: true },
          { isMinistered: true },
          { organizationId: null },
        ]
      });
    }

    // ── 2. Role-based Archive Filtering ─────────────────────────────────────
    // For regular users (non-HQ Admin, non-President): strictly exclude Archive songs and programs
    if (!isHQOrPresident) {
      andConditions.push({
        status: { notIn: ['hq_only', 'archive', 'archived'] },
        category: { notIn: ['archive', 'archived'] },
        programSongs: {
          none: {
            program: {
              OR: [
                { isArchived: true },
                { status: { in: ['archive', 'archived'] } },
                { category: { in: ['archive', 'archived'] } },
              ]
            }
          }
        }
      });
    }

    const rows = await prisma.song.findMany({
      where: {
        AND: andConditions,
      },
      include: {
        roleAssignments: { include: { user: true } },
        programSongs: {
          include: {
            program: {
              select: { id: true, name: true, bannerImage: true }
            }
          },
          take: 1
        }
      },
      take: limit * 2,
    });

    const scoredSongs = rows.map((s: any) => {
      const formatted = formatSong(s);
      const titleLower = (formatted.title || '').toLowerCase();
      const lyricsClean = stripHtmlText(formatted.lyrics || '');
      const lyricsLower = lyricsClean.toLowerCase();
      const singerLower = (formatted.leadSinger || '').toLowerCase();
      const writerLower = (formatted.writer || '').toLowerCase();
      const commentsClean = stripHtmlText(formatted.notes || formatted.coordinatorComment || '');
      const commentsLower = commentsClean.toLowerCase();

      let score = 0;
      let matchField = '';
      let snippet = '';

      if (titleLower.includes(cleanQ)) {
        score = 100;
        matchField = 'title';
      } else if (queryWords.length > 1 && queryWords.every(w => titleLower.includes(w))) {
        score = 88;
        matchField = 'title';
      } else if (singerLower.includes(cleanQ) || writerLower.includes(cleanQ)) {
        score = 75;
        matchField = singerLower.includes(cleanQ) ? 'leadSinger' : 'writer';
      } else if (lyricsLower.includes(cleanQ)) {
        score = 55;
        matchField = 'lyrics';
        snippet = extractChatSnippet(lyricsClean, cleanQ, queryWords);
      } else if (queryWords.length > 1 && queryWords.every(w => lyricsLower.includes(w))) {
        score = 45;
        matchField = 'lyrics';
        snippet = extractChatSnippet(lyricsClean, queryWords[0], queryWords);
      } else if (commentsLower.includes(cleanQ)) {
        score = 40;
        matchField = 'comments';
        snippet = extractChatSnippet(commentsClean, cleanQ, queryWords);
      } else if (lyricsLower.length > 0 && queryWords.some(w => w.length >= 3 && lyricsLower.includes(w))) {
        score = 30;
        matchField = 'lyrics';
        snippet = extractChatSnippet(lyricsClean, queryWords[0], queryWords);
      } else {
        score = 20;
        matchField = 'title';
      }

      return {
        ...formatted,
        searchResult: {
          isMatch: true,
          score,
          matchField,
          snippet: snippet || undefined,
          matchTokens: [cleanQ, ...queryWords],
        }
      };
    });

    scoredSongs.sort((a, b) => b.searchResult.score - a.searchResult.score);
    const finalResults = scoredSongs.slice(0, limit);

    res.json({
      success: true,
      count: finalResults.length,
      data: finalResults,
    });
  } catch (err) {
    console.error('[songs/universal-search]', err);
    res.status(500).json({ success: false, error: 'Failed to search songs' });
  }
};

router.get('/universal-search', optionalAuth, universalSearchHandler);
router.get('/search', optionalAuth, universalSearchHandler);
router.get('/master', requireAuth, getMinisteredSongsHandler);
router.get('/ministered', requireAuth, getMinisteredSongsHandler);

const getMinisteredSongByIdHandler = async (req: Request, res: Response) => {
  try {
    const song = await prisma.song.findUnique({
      where: { id: req.params.id },
    });
    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }
    res.json({ success: true, data: formatSong(song) });
  } catch (err) {
    console.error('[songs/master/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load song' });
  }
};

router.get('/master/:id', requireAuth, getMinisteredSongByIdHandler);
router.get('/ministered/:id', requireAuth, getMinisteredSongByIdHandler);

router.post('/import-from-ministered', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songIds = [] } = req.body || {};
    const orgId = req.tenant?.effectiveZoneId || 'zone-001';

    if (!Array.isArray(songIds) || songIds.length === 0) {
      return res.status(400).json({ success: false, error: 'songIds array is required' });
    }

    const songs = await prisma.song.findMany({
      where: { id: { in: songIds } },
    });

    for (const song of songs) {
      await prisma.song.update({
        where: { id: song.id },
        data: {
          organizationId: orgId,
          status: 'active',
        },
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: `${songs.length} song(s) imported to repertoire.`,
      importedCount: songs.length,
    });
  } catch (err) {
    console.error('[songs/import-from-ministered]', err);
    res.status(500).json({ success: false, error: 'Failed to import songs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MAIN REPERTOIRE & PROGRAM SONGS
// ─────────────────────────────────────────────────────────────────────────────
const getSongsHandler = async (req: Request, res: Response) => {
  try {
    const { praiseNightId, programId, zoneId, subGroupId, churchId, status } = req.query as Record<string, string>;
    const targetProgramId = programId || praiseNightId;
    const targetOrgId = zoneId || req.tenant?.effectiveZoneId || 'zone-001';

    let songs: any[] = [];

    if (targetProgramId) {
      // ── Path A: songs linked via programSongs junction table (canonical) ──────
      const program = await prisma.program.findUnique({
        where: { id: targetProgramId },
        include: {
          programSongs: {
            include: {
              song: {
                include: {
                  roleAssignments: { include: { user: true } },
                },
              },
            },
            orderBy: { order: 'asc' },
          },
        },
      });

      if (program && Array.isArray(program.programSongs)) {
        songs = program.programSongs
          .filter((ps) => ps.song) // guard against orphaned junction rows
          .map((ps) => ({
            ...ps.song,
            order: ps.order,
            praiseNightId: targetProgramId,
            programId: targetProgramId,
          }));
      }

      // ── Path B: legacy songs that store programId as a direct column ──────────
      // Some songs were added before the junction table existed; include them too.
      if (songs.length === 0) {
        const legacySongs = await prisma.song.findMany({
          where: { programId: targetProgramId } as any,
          include: { roleAssignments: { include: { user: true } } },
          orderBy: { createdAt: 'asc' },
        }).catch(() => [] as any[]);

        if (legacySongs.length > 0) {
          songs = legacySongs.map((s: any, idx: number) => ({
            ...s,
            order: s.order ?? idx + 1,
            praiseNightId: targetProgramId,
            programId: targetProgramId,
          }));
        }
      } else {
        // Merge: add any legacy songs not already covered by the junction
        const junctionIds = new Set(songs.map((s: any) => s.id));
        const legacySongs = await prisma.song.findMany({
          where: { programId: targetProgramId } as any,
          include: { roleAssignments: { include: { user: true } } },
          orderBy: { createdAt: 'asc' },
        }).catch(() => [] as any[]);

        legacySongs.forEach((s: any, idx: number) => {
          if (!junctionIds.has(s.id)) {
            songs.push({
              ...s,
              order: s.order ?? songs.length + idx + 1,
              praiseNightId: targetProgramId,
              programId: targetProgramId,
            });
          }
        });
      }
    } else {
      // Query songs for this organization or public master library
      const where: any = {
        OR: [
          { isMaster: true },
          { organizationId: targetOrgId },
        ],
      };

      if (status) {
        where.status = status;
      }

      songs = await prisma.song.findMany({
        where,
        include: {
          roleAssignments: { include: { user: true } },
        },
        orderBy: { title: 'asc' },
      });
    }

    const formatted = songs.map(formatSong);
    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    console.error('[songs:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load songs' });
  }
};

router.get('/', requireAuth, getSongsHandler);
router.get('/praise-night', requireAuth, getSongsHandler);
router.get('/zone', requireAuth, getSongsHandler);
router.get('/zone-songs', requireAuth, getSongsHandler);

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SONGS — precise single-query endpoint, no scanning
// GET /songs/active?zoneId=xxx
// Returns ONLY songs with status='live' scoped to the caller's zone.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/active', requireAuth, async (req: Request, res: Response) => {
  try {
    const zoneId = (req.query.zoneId as string) || req.tenant?.effectiveZoneId || 'zone-001';

    const liveSongs = await prisma.song.findMany({
      where: {
        status: 'live',
        isActive: true,
        OR: [
          { organizationId: zoneId },
          { isMaster: true },
        ],
      },
      include: {
        roleAssignments: { include: { user: true } },
        programSongs: {
          include: { program: { select: { id: true, name: true } } },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const formatted = liveSongs.map(formatSong);
    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    console.error('[songs:active]', err);
    res.status(500).json({ success: false, error: 'Failed to load live songs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SONG HISTORY (Must be BEFORE /:id so Express does not capture /history as an ID!)
// ─────────────────────────────────────────────────────────────────────────────
const getSongHistoryHandler = async (req: Request, res: Response) => {
  try {
    const songId = (req.params.id || req.query.songId || '') as string;
    if (!songId) {
      res.status(400).json({ success: false, error: 'Missing songId' });
      return;
    }

    const song = await prisma.song.findUnique({
      where: { id: songId },
      include: {
        programSongs: {
          include: { program: true },
          orderBy: { program: { createdAt: 'desc' } },
        },
      },
    });

    const history = await prisma.songHistory.findMany({
      where: { songId },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const formatted: any[] = history.map((h) => {
      // All columns are now properly populated by the backfill script.
      // Read directly from structured columns — no rawData fallback.
      const resolvedType        = (h.type        || 'details').toLowerCase().trim();
      const resolvedNewValue    = h.newValue    || '';
      const resolvedOldValue    = h.oldValue    || '';

      let resolvedTitle = h.description || 'Song Update';
      let resolvedNotes = '';

      if (h.description && typeof h.description === 'string' && h.description.trim().startsWith('{') && h.description.trim().endsWith('}')) {
        try {
          const parsed = JSON.parse(h.description.trim());
          if (parsed && typeof parsed === 'object') {
            resolvedTitle = (parsed.title || parsed.description || resolvedTitle).trim();
            resolvedNotes = (parsed.notes || '').trim();
          }
        } catch {}
      } else if (h.description && h.description.includes(' — ')) {
        const parts = h.description.split(' — ');
        resolvedTitle = parts[0].trim();
        resolvedNotes = parts.slice(1).join(' — ').trim();
      }

      // Audio URL: newValue is the URL for audio-type entries
      const resolvedAudioUrl = resolvedType === 'audio' ? resolvedNewValue : null;

      const createdBy = h.user
        ? [h.user.firstName, h.user.lastName].filter(Boolean).join(' ') || h.user.email || 'Admin'
        : 'Admin';

      return {
        id: h.id,
        songId: h.songId,
        type: resolvedType,
        title: resolvedTitle,
        description: resolvedNotes || resolvedTitle,
        notes: resolvedNotes,
        old_value: resolvedOldValue,
        new_value: resolvedNewValue,
        oldValue: resolvedOldValue,
        newValue: resolvedNewValue,
        audioUrl: resolvedAudioUrl,
        createdBy,
        createdAt: h.createdAt,
        created_at: h.createdAt,
      };
    });

    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    console.error('[songs/history:GET]', err);
    res.status(500).json({ success: false, error: 'Failed to load song history' });
  }
};

router.get('/history', requireAuth, getSongHistoryHandler);
router.get('/:id/history', requireAuth, getSongHistoryHandler);

router.post('/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const { songId, type, title, description } = body;
    const rawOld = body.old_value !== undefined ? body.old_value : body.oldValue;
    const rawNew = body.new_value !== undefined ? body.new_value : body.newValue;

    if (!songId) {
      res.status(400).json({ success: false, error: 'Missing songId' });
      return;
    }

    const cleanTitle = (title || description || 'Song Update').trim();
    const cleanNotes = (description || '').trim();

    let descToSave = cleanTitle;
    if (cleanNotes && cleanNotes !== cleanTitle) {
      descToSave = JSON.stringify({ title: cleanTitle, notes: cleanNotes });
    }

    let validUserId: string | null = null;
    if (res.locals.auth?.userId) {
      const userExists = await prisma.user.findUnique({
        where: { id: res.locals.auth.userId },
        select: { id: true },
      });
      if (userExists) validUserId = userExists.id;
    }

    const entry = await prisma.songHistory.create({
      data: {
        songId,
        userId: validUserId,
        type: type || 'metadata',
        description: descToSave,
        oldValue: typeof rawOld === 'object' ? JSON.stringify(rawOld) : String(rawOld || ''),
        newValue: typeof rawNew === 'object' ? JSON.stringify(rawNew) : String(rawNew || ''),
      },
    });

    const formattedEntry = {
      id: entry.id,
      songId: entry.songId,
      type: entry.type,
      title: cleanTitle,
      description: cleanNotes || cleanTitle,
      notes: cleanNotes,
      old_value: entry.oldValue,
      new_value: entry.newValue,
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      createdAt: entry.createdAt,
      created_at: entry.createdAt,
    };

    broadcast('song_history', entry.songId, formattedEntry);

    res.status(201).json({
      success: true,
      data: formattedEntry,
    });
  } catch (err) {
    console.error('[songs/history:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to record song history' });
  }
});

router.patch('/history/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const { type, title, description } = body;
    const rawOld = body.old_value !== undefined ? body.old_value : body.oldValue;
    const rawNew = body.new_value !== undefined ? body.new_value : body.newValue;

    const existing = await prisma.songHistory.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'History entry not found' });
    }

    let currentTitle = existing.description || 'Song Update';
    let currentNotes = '';
    if (existing.description && existing.description.trim().startsWith('{') && existing.description.trim().endsWith('}')) {
      try {
        const parsed = JSON.parse(existing.description.trim());
        if (parsed && typeof parsed === 'object') {
          currentTitle = parsed.title || currentTitle;
          currentNotes = parsed.notes || '';
        }
      } catch {}
    } else if (existing.description && existing.description.includes(' — ')) {
      const parts = existing.description.split(' — ');
      currentTitle = parts[0].trim();
      currentNotes = parts.slice(1).join(' — ').trim();
    }

    const nextTitle = title !== undefined ? String(title).trim() : currentTitle;
    const nextNotes = description !== undefined ? String(description).trim() : currentNotes;

    let descToSave = nextTitle;
    if (nextNotes && nextNotes !== nextTitle) {
      descToSave = JSON.stringify({ title: nextTitle, notes: nextNotes });
    }

    const updateData: any = {
      description: descToSave,
    };
    if (type !== undefined) updateData.type = type;
    if (rawOld !== undefined) updateData.oldValue = typeof rawOld === 'object' ? JSON.stringify(rawOld) : String(rawOld || '');
    if (rawNew !== undefined) updateData.newValue = typeof rawNew === 'object' ? JSON.stringify(rawNew) : String(rawNew || '');

    const updated = await prisma.songHistory.update({
      where: { id },
      data: updateData,
    });

    const formattedUpdated = {
      id: updated.id,
      songId: updated.songId,
      type: updated.type,
      title: nextTitle,
      description: nextNotes || nextTitle,
      notes: nextNotes,
      old_value: updated.oldValue,
      new_value: updated.newValue,
      oldValue: updated.oldValue,
      newValue: updated.newValue,
      createdAt: updated.createdAt,
      created_at: updated.createdAt,
    };

    broadcast('song_history', updated.songId, formattedUpdated);

    res.json({
      success: true,
      data: formattedUpdated,
    });
  } catch (err) {
    console.error('[songs/history:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update song history' });
  }
});

router.delete('/history/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await prisma.songHistory.findUnique({ where: { id } });
    if (!existing) {
      return res.json({ success: true, message: 'History entry already deleted' });
    }
    await prisma.songHistory.delete({ where: { id } });
    broadcast('song_history', existing.songId, { id: existing.id, songId: existing.songId, deleted: true });
    res.json({ success: true, message: 'History entry deleted' });
  } catch (err) {
    console.error('[songs/history:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete history entry' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVE / LIVE SONGS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/active', requireAuth, async (req: Request, res: Response) => {
  try {
    const targetOrgId = (req.query.zoneId as string) || req.tenant?.effectiveZoneId || 'zone-001';
    const activeSongs = await prisma.song.findMany({
      where: {
        status: 'live',
        OR: [
          { isMaster: true },
          { organizationId: targetOrgId },
          { organizationId: null },
        ],
      },
      include: {
        roleAssignments: { include: { user: true } },
        programSongs: { include: { program: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const formatted = activeSongs.map(formatSong);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.json({ success: true, count: formatted.length, data: formatted });
  } catch (err) {
    console.error('[songs:active]', err);
    res.status(500).json({ success: false, error: 'Failed to load active songs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SONG BY ID
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const song = await prisma.song.findUnique({
      where: { id: req.params.id },
      include: {
        programSongs: {
          include: { program: true },
        },
      },
    });

    if (!song) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }

    res.json({ success: true, data: formatSong(song) });
  } catch (err) {
    console.error('[songs/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to load song' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CREATE SONG
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const songId = body.id || `song_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const organizationId = body.zoneId || body.organizationId || req.tenant?.effectiveZoneId || 'zone-001';
    let resolvedProgramId = body.praiseNightId || body.programId || null;
    const isMasterOrMinistered = Boolean(body.isMaster || body.isMinistered);
    const candidateProgName = body.program || body.programName || (isMasterOrMinistered ? body.category : null);
    if (!resolvedProgramId && candidateProgName) {
      const found = await prisma.program.findFirst({
        where: { name: { equals: String(candidateProgName).trim(), mode: 'insensitive' } },
        select: { id: true },
      });
      if (found) resolvedProgramId = found.id;
    }

    const isHqOnly = Boolean(body.isHQOnly || body.is_hq_only || body.isHqOnly || body.scope === 'hq');
    let audioUrlsData = body.audioUrls || body.audio_urls || null;
    if (isHqOnly) {
      if (!audioUrlsData || typeof audioUrlsData !== 'object') audioUrlsData = {};
      audioUrlsData = { ...audioUrlsData, _isHQOnly: true };
    }

    const newSong = await prisma.song.create({
      data: {
        id: songId,
        organizationId,
        groupId: body.groupId || body.subGroupId || body.churchId || null,
        title: body.title || 'Untitled Song',
        key: body.key || null,
        tempo: body.tempo || null,
        lyrics: body.lyrics || '',
        writer: body.writer || '',
        conductor: body.conductor || body.conductorGuide || '',
        leadSinger: body.leadSinger || body.lead_singer || '',
        drummer: body.drummer || '',
        leadKeyboardist: body.leadKeyboardist || body.lead_keyboardist || '',
        leadGuitarist: body.leadGuitarist || body.lead_guitarist || '',
        bassGuitarist: body.bassGuitarist || body.bass_guitarist || '',
        solfas: body.solfas || body.solfa || '',
        audioFile: body.audioFile || body.audio_file || body.audioUrl || null,
        audioUrls: audioUrlsData,
        category: body.category || 'Praise Night',
        status: isHqOnly ? 'hq_only' : (body.status || 'active'),
        isMaster: Boolean(body.isMaster),
        isMinistered: Boolean(body.isMinistered),
        rehearsalCount: Math.max(0, parseInt(body.rehearsalCount ?? body.rehearsal_count, 10) || 0),
        comments: typeof body.comments === 'object' ? JSON.stringify(body.comments) : (body.comments || null),
        notes: typeof body.notes === 'string' ? body.notes : (body.coordinatorComment || null),
        ...(resolvedProgramId
          ? {
              programSongs: {
                create: {
                  programId: resolvedProgramId,
                  order: body.order || 1,
                },
              },
            }
          : {}),
      },
    });

    broadcast('songs', newSong.id, formatSong(newSong));
    res.status(201).json({ success: true, message: 'Song created', data: formatSong(newSong) });
  } catch (err) {
    console.error('[songs:POST]', err);
    res.status(500).json({ success: false, error: 'Failed to create song' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. UPDATE SONG
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });
    if (!existing) {
      res.status(404).json({ success: false, error: 'Song not found' });
      return;
    }

    const data: Record<string, any> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.writer !== undefined) data.writer = body.writer;
    if (body.conductor !== undefined || body.conductorGuide !== undefined) data.conductor = body.conductor || body.conductorGuide;
    if (body.leadSinger !== undefined || body.lead_singer !== undefined) data.leadSinger = body.leadSinger || body.lead_singer;
    if (body.drummer !== undefined) data.drummer = body.drummer;
    if (body.leadKeyboardist !== undefined || body.lead_keyboardist !== undefined) data.leadKeyboardist = body.leadKeyboardist || body.lead_keyboardist;
    if (body.leadGuitarist !== undefined || body.lead_guitarist !== undefined) data.leadGuitarist = body.leadGuitarist || body.lead_guitarist;
    if (body.bassGuitarist !== undefined || body.bass_guitarist !== undefined) data.bassGuitarist = body.bassGuitarist || body.bass_guitarist;
    if (body.solfas !== undefined || body.solfa !== undefined) data.solfas = body.solfas || body.solfa;
    if (body.audioFile !== undefined || body.audio_file !== undefined || body.audioUrl !== undefined) {
      data.audioFile = body.audioFile || body.audio_file || body.audioUrl;
    }
    if (body.audioUrls !== undefined || body.audio_urls !== undefined) data.audioUrls = body.audioUrls || body.audio_urls;
    if (body.category !== undefined) data.category = body.category;
    if (body.status !== undefined) data.status = body.status;
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    if (data.status === 'live') {
      data.isActive = true;
    } else if (data.status && ['heard', 'unheard', 'inactive', 'off', 'ended', 'stopped'].includes(String(data.status).toLowerCase())) {
      data.isActive = false;
    }

    if (body.rehearsalCount !== undefined || body.rehearsal_count !== undefined) {
      data.rehearsalCount = Math.max(0, parseInt(body.rehearsalCount ?? body.rehearsal_count, 10) || 0);
    }

    if (body.comments !== undefined || body.coordinatorComment !== undefined || body.notes !== undefined) {
      let resolvedNotes = '';
      if (typeof body.notes === 'string' && body.notes.trim()) {
        resolvedNotes = body.notes.trim();
      } else if (typeof body.coordinatorComment === 'string' && body.coordinatorComment.trim()) {
        resolvedNotes = body.coordinatorComment.trim();
      }

      let commentsArr: any[] = [];
      if (Array.isArray(body.comments)) {
        commentsArr = body.comments;
      } else if (typeof body.comments === 'string' && body.comments.trim()) {
        const trimmed = body.comments.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            commentsArr = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            commentsArr = [{ id: `comment-${Date.now()}`, text: trimmed, author: 'Coordinator', date: new Date().toISOString() }];
          }
        } else {
          commentsArr = [{ id: `comment-${Date.now()}`, text: trimmed, author: 'Coordinator', date: new Date().toISOString() }];
        }
      }

      if (commentsArr.length === 0 && resolvedNotes) {
        commentsArr = [{
          id: `comment-${Date.now()}`,
          text: resolvedNotes,
          author: 'Coordinator',
          date: new Date().toISOString(),
          audioUrl: typeof body.coordinatorAudioUrl === 'string' ? body.coordinatorAudioUrl : ''
        }];
      }

      if (!resolvedNotes && commentsArr.length > 0) {
        const last = commentsArr[commentsArr.length - 1];
        resolvedNotes = typeof last === 'string' ? last : (last?.text || last?.comment || last?.content || '');
      }

      data.comments = JSON.stringify(commentsArr);
      data.notes = resolvedNotes;
    }

    if (body.isHQOnly !== undefined || body.is_hq_only !== undefined || body.isHqOnly !== undefined || body.scope !== undefined) {
      const isHqOnly = Boolean(body.isHQOnly || body.is_hq_only || body.isHqOnly || body.scope === 'hq');
      const currentAudioUrls = (existing.audioUrls && typeof existing.audioUrls === 'object') ? { ...(existing.audioUrls as any) } : {};
      data.audioUrls = { ...currentAudioUrls, ...(data.audioUrls || {}), _isHQOnly: isHqOnly };
      data.status = isHqOnly ? 'hq_only' : (body.status || (existing.status === 'hq_only' ? 'active' : existing.status));
    }

    const updated = await prisma.song.update({
      where: { id: songId },
      data,
    });

    // Auto-record history if rehearsal audio changed
    if (data.audioFile && data.audioFile !== existing.audioFile) {
      try {
        const titleDesc = `MOST UPDATED REHEARSAL (${updated.title})`;
        const notesDesc = `Recorded Rehearsal - ${updated.leadSinger || 'Loveworld Singers'}`;
        const autoEntry = await prisma.songHistory.create({
          data: {
            songId,
            userId: res.locals.auth?.userId || null,
            type: 'audio',
            description: JSON.stringify({ title: titleDesc, notes: notesDesc }),
            oldValue: existing.audioFile || '',
            newValue: data.audioFile,
          },
        });
        broadcast('song_history', songId, {
          id: autoEntry.id,
          songId,
          type: 'audio',
          title: titleDesc,
          description: notesDesc,
          notes: notesDesc,
          audioUrl: data.audioFile,
          new_value: data.audioFile,
          old_value: existing.audioFile || '',
          created_at: autoEntry.createdAt,
        });
      } catch (e) {
        console.warn('[songs:PATCH] Auto-record audio history failed:', e);
      }
    }

    let resolvedProgramId = body.praiseNightId || body.programId || null;
    const isMasterOrMinistered = Boolean(body.isMaster !== undefined ? body.isMaster : (existing.isMaster || existing.isMinistered));
    const candidateProgName = body.program || body.programName || (isMasterOrMinistered && body.category ? body.category : null);
    if (!resolvedProgramId && candidateProgName) {
      const found = await prisma.program.findFirst({
        where: { name: { equals: String(candidateProgName).trim(), mode: 'insensitive' } },
        select: { id: true },
      });
      if (found) resolvedProgramId = found.id;
    }

    if (resolvedProgramId) {
      await prisma.programSong.upsert({
        where: {
          programId_songId: {
            programId: resolvedProgramId,
            songId,
          },
        },
        create: {
          programId: resolvedProgramId,
          songId,
          order: body.order || 1,
        },
        update: {},
      }).catch(() => {});
    }

    const formatted = formatSong(updated);
    broadcast('songs', songId, formatted);
    broadcast('song', songId, formatted);
    broadcast('songs', 'all', formatted);
    broadcast('song', 'all', formatted);
    res.json({ success: true, message: 'Song updated', data: formatted });
  } catch (err) {
    console.error('[songs:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to update song' });
  }
});

// PATCH /songs/:id/status & PATCH /songs/praise-night/:id/status
const updateSongStatusHandler = async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    const { status } = req.body;

    const isGoingLive = status === 'live';

    if (isGoingLive) {
      // Deactivate any other currently live songs in the same program
      const existingWithPrograms = await prisma.song.findUnique({
        where: { id: songId },
        include: { programSongs: true },
      });
      const programIds = existingWithPrograms?.programSongs?.map((ps) => ps.programId) || [];
      if (programIds.length > 0) {
        await prisma.song.updateMany({
          where: {
            id: { not: songId },
            status: 'live',
            programSongs: { some: { programId: { in: programIds } } },
          },
          data: { status: 'heard', isActive: false },
        }).catch(() => {});
      }
    }

    const updated = await prisma.song.update({
      where: { id: songId },
      data: {
        status: status || 'active',
        isActive: isGoingLive,
      },
    });

    const formatted = formatSong(updated);
    broadcast('songs', songId, formatted);
    broadcast('song', songId, formatted);
    broadcast('songs', 'all', formatted);
    broadcast('song', 'all', formatted);
    broadcast('song_status', songId, { id: songId, status: updated.status });
    // Dedicated live_song event — clients listen to this directly instead of scanning
    broadcast('live_song', 'all', isGoingLive ? formatted : { id: songId, status: updated.status, isActive: false });
    res.json({ success: true, message: 'Song status updated', data: formatted });
  } catch (err) {
    console.error('[songs:status]', err);
    res.status(500).json({ success: false, error: 'Failed to update song status' });
  }
};

router.patch('/:id/status', requireAuth, updateSongStatusHandler);
router.patch('/praise-night/:id/status', requireAuth, updateSongStatusHandler);
router.patch('/praise-night/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    const body = req.body || {};

    const existing = await prisma.song.findUnique({ where: { id: songId } });
    if (!existing) return res.status(404).json({ success: false, error: 'Song not found' });

    const data: Record<string, any> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.key !== undefined) data.key = body.key;
    if (body.tempo !== undefined) data.tempo = body.tempo;
    if (body.lyrics !== undefined) data.lyrics = body.lyrics;
    if (body.writer !== undefined) data.writer = body.writer;
    if (body.conductor !== undefined || body.conductorGuide !== undefined) data.conductor = body.conductor || body.conductorGuide;
    if (body.leadSinger !== undefined || body.lead_singer !== undefined) data.leadSinger = body.leadSinger || body.lead_singer;
    if (body.drummer !== undefined) data.drummer = body.drummer;
    if (body.leadKeyboardist !== undefined || body.lead_keyboardist !== undefined) data.leadKeyboardist = body.leadKeyboardist || body.lead_keyboardist;
    if (body.leadGuitarist !== undefined || body.lead_guitarist !== undefined) data.leadGuitarist = body.leadGuitarist || body.lead_guitarist;
    if (body.bassGuitarist !== undefined || body.bass_guitarist !== undefined) data.bassGuitarist = body.bassGuitarist || body.bass_guitarist;
    if (body.solfas !== undefined || body.solfa !== undefined) data.solfas = body.solfas || body.solfa;
    if (body.audioFile !== undefined || body.audio_file !== undefined || body.audioUrl !== undefined) {
      data.audioFile = body.audioFile || body.audio_file || body.audioUrl;
    }
    if (body.audioUrls !== undefined || body.audio_urls !== undefined) data.audioUrls = body.audioUrls || body.audio_urls;
    if (body.category !== undefined) data.category = body.category;
    if (body.rehearsalCount !== undefined || body.rehearsal_count !== undefined) {
      data.rehearsalCount = Math.max(0, parseInt(body.rehearsalCount ?? body.rehearsal_count, 10) || 0);
    }

    if (body.comments !== undefined || body.coordinatorComment !== undefined || body.notes !== undefined) {
      let resolvedNotes = '';
      if (typeof body.notes === 'string' && body.notes.trim()) {
        resolvedNotes = body.notes.trim();
      } else if (typeof body.coordinatorComment === 'string' && body.coordinatorComment.trim()) {
        resolvedNotes = body.coordinatorComment.trim();
      }

      let commentsArr: any[] = [];
      if (Array.isArray(body.comments)) {
        commentsArr = body.comments;
      } else if (typeof body.comments === 'string' && body.comments.trim()) {
        const trimmed = body.comments.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            commentsArr = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            commentsArr = [{ id: `comment-${Date.now()}`, text: trimmed, author: 'Coordinator', date: new Date().toISOString() }];
          }
        } else {
          commentsArr = [{ id: `comment-${Date.now()}`, text: trimmed, author: 'Coordinator', date: new Date().toISOString() }];
        }
      }

      if (commentsArr.length === 0 && resolvedNotes) {
        commentsArr = [{
          id: `comment-${Date.now()}`,
          text: resolvedNotes,
          author: 'Coordinator',
          date: new Date().toISOString(),
          audioUrl: typeof body.coordinatorAudioUrl === 'string' ? body.coordinatorAudioUrl : ''
        }];
      }

      if (!resolvedNotes && commentsArr.length > 0) {
        const last = commentsArr[commentsArr.length - 1];
        resolvedNotes = typeof last === 'string' ? last : (last?.text || last?.comment || last?.content || '');
      }

      data.comments = JSON.stringify(commentsArr);
      data.notes = resolvedNotes;
    }

    if (body.isActive !== undefined || body.isLive !== undefined) {
      const nextLive = Boolean(body.isActive ?? body.isLive);
      data.isActive = nextLive;
      if (nextLive) {
        data.status = 'live';
      } else {
        data.status = 'heard';
      }
    }

    // Map isHeard boolean to status string; isHeard takes priority over status
    if (body.isHeard !== undefined) {
      data.status = body.isHeard ? 'heard' : 'unheard';
      data.isActive = false;
    } else if (body.status !== undefined) {
      data.status = body.status;
      if (body.status === 'live') {
        data.isActive = true;
      } else if (['heard', 'unheard', 'inactive', 'off', 'ended', 'stopped'].includes(String(body.status).toLowerCase())) {
        data.isActive = false;
      }
    }

    // Safety sync: status='live' MUST have isActive=true; non-live status MUST have isActive=false
    if (data.status === 'live') {
      data.isActive = true;
    } else if (data.status && ['heard', 'unheard', 'inactive', 'off', 'ended', 'stopped'].includes(String(data.status).toLowerCase())) {
      data.isActive = false;
    }

    if (data.status === 'live' && data.isActive) {
      // Deactivate any other live songs in the same program
      const existingWithPrograms = await prisma.song.findUnique({
        where: { id: songId },
        include: { programSongs: true },
      });
      const programIds = existingWithPrograms?.programSongs?.map((ps) => ps.programId) || [];
      if (programIds.length > 0) {
        await prisma.song.updateMany({
          where: {
            id: { not: songId },
            status: 'live',
            programSongs: { some: { programId: { in: programIds } } },
          },
          data: { status: 'heard', isActive: false },
        }).catch(() => {});
      }
    }

    const updated = await prisma.song.update({
      where: { id: songId },
      data,
    });

    const formatted = formatSong(updated);
    broadcast('songs', songId, formatted);
    broadcast('song', songId, formatted);
    broadcast('songs', 'all', formatted);
    broadcast('song', 'all', formatted);
    // Dedicated live_song event — clients update widget instantly without scanning
    const isNowLive = updated.status === 'live' && updated.isActive;
    broadcast('live_song', 'all', isNowLive ? formatted : { id: songId, status: updated.status, isActive: false });
    res.json({ success: true, message: 'Song updated', data: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update song' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. DELETE SONG
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const songId = req.params.id;
    await prisma.song.delete({ where: { id: songId } });

    broadcast('songs', songId, { id: songId, deleted: true });
    broadcast('songs', 'all', { id: songId, deleted: true });
    res.json({ success: true, message: 'Song deleted' });
  } catch (err) {
    console.error('[songs:DELETE]', err);
    res.status(500).json({ success: false, error: 'Failed to delete song' });
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// 8. PERSONAL NOTES & DOODLE ANNOTATIONS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/notes/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.params;
    const userId = res.locals.auth?.userId || 'guest';

    let noteText = '';
    if (userId && userId !== 'guest') {
      try {
        const record = await prisma.userSongNote.findUnique({
          where: { songId_userId: { songId, userId } },
        });
        if (record?.notes) noteText = record.notes;
      } catch {}
    }

    if (!noteText) {
      try {
        const key = `song_note_${userId}_${songId}`;
        const setting = await prisma.setting.findUnique({ where: { key } });
        if (setting?.value && typeof setting.value === 'object') {
          noteText = (setting.value as any).notes || (setting.value as any).note || '';
        } else if (typeof setting?.value === 'string') {
          noteText = setting.value;
        }
      } catch {}
    }

    res.json({ success: true, data: { notes: noteText, note: noteText } });
  } catch (err) {
    console.error('[songs/notes:GET]', err);
    res.json({ success: true, data: { notes: '', note: '' } });
  }
});

router.patch('/notes/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.params;
    const userId = res.locals.auth?.userId || 'guest';
    const notes = typeof req.body === 'string' ? req.body : (req.body?.notes ?? req.body?.note ?? '');

    if (userId && userId !== 'guest') {
      try {
        await prisma.userSongNote.upsert({
          where: { songId_userId: { songId, userId } },
          update: { notes: String(notes) },
          create: { songId, userId, notes: String(notes) },
        });
      } catch (err: any) {
        console.warn('[songs/notes:userSongNote upsert]:', err?.message);
      }
    }

    try {
      const key = `song_note_${userId}_${songId}`;
      await prisma.setting.upsert({
        where: { key },
        update: { value: { notes: String(notes), updatedAt: new Date().toISOString() } },
        create: { key, value: { notes: String(notes), updatedAt: new Date().toISOString() } },
      });
    } catch (err: any) {
      console.warn('[songs/notes:setting upsert]:', err?.message);
    }

    res.json({ success: true, message: 'Notes saved', data: { notes: String(notes) } });
  } catch (err) {
    console.error('[songs/notes:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to save notes' });
  }
});

router.get('/annotations/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.params;
    const key = `song_anno_${songId}`;

    const setting = await prisma.setting.findUnique({ where: { key } });
    const strokes = setting?.value && typeof setting.value === 'object' ? (setting.value as any).strokes || [] : [];

    res.json({ success: true, data: { strokes } });
  } catch (err) {
    console.error('[songs/annotations:GET]', err);
    res.json({ success: true, data: { strokes: [] } });
  }
});

router.patch('/annotations/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { songId } = req.params;
    const key = `song_anno_${songId}`;
    const strokes = req.body.data?.strokes || req.body.strokes || [];

    await prisma.setting.upsert({
      where: { key },
      update: { value: { strokes, updatedAt: new Date().toISOString() } },
      create: { key, value: { strokes, updatedAt: new Date().toISOString() } },
    });

    broadcast('annotation', songId, { songId, strokes });
    res.json({ success: true, message: 'Annotations saved', data: { strokes } });
  } catch (err) {
    console.error('[songs/annotations:PATCH]', err);
    res.status(500).json({ success: false, error: 'Failed to save annotations' });
  }
});

export default router;
