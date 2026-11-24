import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Router } from 'express';
import { z } from 'zod';
import { buildUnifiedSystemInstruction } from '../../src/shared/assistantPolicy';
import { arrangeImagesOnVoiceoverTimeline } from '../../src/shared/orchestrator';
import { computeEstimatedCostUsd, reconcileTokenRecord } from '../../src/shared/quotas';
import type { VideoTimelineClip } from '../../src/shared/types';
import { DATA_DIR, db, recordAuditLog } from '../db';
import { type AuthenticatedRequest, requireAuth } from '../middleware';
import { generateModelText } from '../providers';
import { createRateLimiter, inspectUploadedBinarySafety } from '../security';

const execFileAsync = promisify(execFile);

export const creativeRouter = Router();
creativeRouter.use(requireAuth);

const renderLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 15, scope: 'creative_render' });
const briefLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 25, scope: 'creative_brief' });

const CREATIVE_DIR = path.join(DATA_DIR, 'creative');
fs.mkdirSync(CREATIVE_DIR, { recursive: true });

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
]);

function safeUserCreativePath(userId: string, filename: string): { rel: string; full: string } {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(CREATIVE_DIR, safeUser);
  fs.mkdirSync(dir, { recursive: true });
  const cleanName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const rel = path.join(safeUser, cleanName);
  const full = path.resolve(CREATIVE_DIR, rel);
  if (!full.startsWith(path.resolve(CREATIVE_DIR))) {
    throw new Error('Invalid creative storage path.');
  }
  return { rel, full };
}

function resolveCreativeRel(relPath: string | null | undefined): string | null {
  if (!relPath) return null;
  const full = path.resolve(CREATIVE_DIR, relPath);
  if (!full.startsWith(path.resolve(CREATIVE_DIR))) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

async function probeMediaDurationSec(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 8000 }
    );
    const val = Number.parseFloat(stdout.trim());
    return Number.isFinite(val) && val > 0 ? Number(val.toFixed(2)) : null;
  } catch {
    return null;
  }
}

creativeRouter.get('/capabilities', async (_req, res) => {
  let ffmpegAvailable = false;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }

  res.json({
    ffmpegAvailable,
    videoRenderingReady: ffmpegAvailable,
    imageGenerationPaidApiConfigured: false,
    imageGenerationStatus:
      'External generative image/video models require an explicitly authorized Paid Gemini API key (disabled by zero-budget rule). Vision analysis, prompt engineering, SVG UI design, voiceover audio, and multi-image FFmpeg MP4 rendering are fully active.',
  });
});

creativeRouter.get('/assets', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare('SELECT * FROM creative_assets WHERE user_id = ? ORDER BY created_at DESC LIMIT 60')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;

  res.json({
    assets: rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      kind: String(r.kind),
      name: String(r.name),
      mimeType: String(r.mime_type),
      sizeBytes: Number(r.size_bytes),
      durationSec: r.duration_sec !== null ? Number(r.duration_sec) : null,
      downloadUrl: `/api/v1/creative/assets/${r.id}/download`,
      createdAt: String(r.created_at),
    })),
  });
});

creativeRouter.post('/assets', async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    kind: z.enum(['image', 'audio', 'music', 'sfx']),
    name: z.string().trim().min(1).max(120),
    mimeType: z.string().trim().min(3).max(80),
    dataBase64: z.string().min(4).max(16_000_000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid asset payload.' });
    return;
  }

  if (parsed.data.kind === 'image' && !ALLOWED_IMAGE_MIMES.has(parsed.data.mimeType)) {
    res.status(400).json({ error: `Unsupported image MIME type: ${parsed.data.mimeType}` });
    return;
  }
  if (parsed.data.kind !== 'image' && !ALLOWED_AUDIO_MIMES.has(parsed.data.mimeType)) {
    res.status(400).json({ error: `Unsupported audio MIME type: ${parsed.data.mimeType}` });
    return;
  }

  const buffer = Buffer.from(parsed.data.dataBase64, 'base64');
  if (buffer.length > 12 * 1024 * 1024) {
    res.status(400).json({ error: 'Media asset exceeds 12MB upload limit.' });
    return;
  }

  const safety = inspectUploadedBinarySafety({
    fileName: parsed.data.name,
    mimeType: parsed.data.mimeType,
    buffer,
  });
  if (!safety.safe) {
    res.status(400).json({ error: safety.reason ?? 'Executable or malformed media payload rejected.' });
    return;
  }

  const ext = path.extname(parsed.data.name) || (parsed.data.kind === 'image' ? '.png' : '.wav');
  const id = crypto.randomUUID();
  const { rel, full } = safeUserCreativePath(req.authUser!.id, `${id}${ext}`);
  fs.writeFileSync(full, buffer);

  const durationSec = parsed.data.kind !== 'image' ? await probeMediaDurationSec(full) : null;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO creative_assets (id, user_id, kind, name, mime_type, size_bytes, duration_sec, storage_rel_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.authUser!.id, parsed.data.kind, parsed.data.name, parsed.data.mimeType, buffer.length, durationSec, rel, now);

  res.status(201).json({
    asset: {
      id,
      userId: req.authUser!.id,
      kind: parsed.data.kind,
      name: parsed.data.name,
      mimeType: parsed.data.mimeType,
      sizeBytes: buffer.length,
      durationSec,
      downloadUrl: `/api/v1/creative/assets/${id}/download`,
      createdAt: now,
    },
  });
});

creativeRouter.get('/assets/:id/download', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM creative_assets WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'Media asset not found.' });
    return;
  }
  const full = resolveCreativeRel(String(row.storage_rel_path));
  if (!full) {
    res.status(404).json({ error: 'Media binary missing.' });
    return;
  }
  res.setHeader('Content-Type', String(row.mime_type));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(full).pipe(res);
});

creativeRouter.delete('/assets/:id', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT storage_rel_path FROM creative_assets WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as { storage_rel_path: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Asset not found.' });
    return;
  }
  const full = resolveCreativeRel(row.storage_rel_path);
  if (full) fs.unlinkSync(full);
  db.prepare('DELETE FROM creative_assets WHERE id = ? AND user_id = ?').run(req.params.id, req.authUser!.id);
  res.json({ ok: true });
});

creativeRouter.get('/projects', (req: AuthenticatedRequest, res) => {
  const rows = db
    .prepare('SELECT * FROM creative_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30')
    .all(req.authUser!.id) as Array<Record<string, unknown>>;
  res.json({
    projects: rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      projectId: r.project_id ? String(r.project_id) : null,
      kind: String(r.kind),
      title: String(r.title),
      config: JSON.parse(String(r.config_json || '{}')),
      outputDownloadUrl: r.output_rel_path ? `/api/v1/creative/projects/${r.id}/download` : null,
      mimeType: r.mime_type ? String(r.mime_type) : null,
      durationSec: r.duration_sec !== null ? Number(r.duration_sec) : null,
      status: String(r.status),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    })),
  });
});

creativeRouter.post('/video/auto-timeline', (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    voiceoverAssetId: z.string().trim().optional().nullable(),
    imageAssetIds: z.array(z.string().trim()).min(1).max(24),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'At least one image asset ID is required.' });
    return;
  }

  let audioDurationSec = parsed.data.imageAssetIds.length * 3;
  if (parsed.data.voiceoverAssetId) {
    const vo = db
      .prepare('SELECT duration_sec FROM creative_assets WHERE id = ? AND user_id = ?')
      .get(parsed.data.voiceoverAssetId, req.authUser!.id) as { duration_sec: number | null } | undefined;
    if (vo?.duration_sec && vo.duration_sec > 0) {
      audioDurationSec = vo.duration_sec;
    }
  }

  const images: Array<{ assetId: string; name: string }> = [];
  for (const id of parsed.data.imageAssetIds) {
    const row = db
      .prepare('SELECT id, name FROM creative_assets WHERE id = ? AND user_id = ?')
      .get(id, req.authUser!.id) as { id: string; name: string } | undefined;
    if (row) images.push({ assetId: row.id, name: row.name });
  }
  if (images.length === 0) {
    res.status(404).json({ error: 'No matching user image assets found.' });
    return;
  }

  const clips = arrangeImagesOnVoiceoverTimeline(images, audioDurationSec);
  res.json({ durationSec: audioDurationSec, clips });
});

creativeRouter.post('/video/render', renderLimiter, async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    title: z.string().trim().min(1).max(100).default('LOODY Studio Video'),
    aspectRatio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
    fps: z.union([z.literal(24), z.literal(30)]).default(24),
    voiceoverAssetId: z.string().trim().min(1),
    musicAssetId: z.string().trim().nullable().optional(),
    musicVolume: z.number().min(0).max(1).default(0.25),
    sfxAssetId: z.string().trim().nullable().optional(),
    sfxStartSec: z.number().min(0).max(600).default(0),
    sfxVolume: z.number().min(0).max(1.5).default(0.75),
    clips: z
      .array(
        z.object({
          id: z.string(),
          assetId: z.string(),
          name: z.string(),
          startSec: z.number().min(0),
          durationSec: z.number().min(0.5).max(120),
          motion: z.enum(['none', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right']),
          transition: z.enum(['none', 'fade', 'wipe']),
        })
      )
      .min(1)
      .max(24),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid render timeline configuration.' });
    return;
  }

  const user = req.authUser!;
  const voRow = db
    .prepare('SELECT * FROM creative_assets WHERE id = ? AND user_id = ?')
    .get(parsed.data.voiceoverAssetId, user.id) as Record<string, unknown> | undefined;
  const voFull = voRow ? resolveCreativeRel(String(voRow.storage_rel_path)) : null;
  if (!voFull) {
    res.status(404).json({ error: 'Voiceover audio asset not found.' });
    return;
  }

  const slidePaths: Array<{ full: string; clip: VideoTimelineClip }> = [];
  for (const clip of parsed.data.clips) {
    const imgRow = db
      .prepare('SELECT storage_rel_path FROM creative_assets WHERE id = ? AND user_id = ?')
      .get(clip.assetId, user.id) as { storage_rel_path: string } | undefined;
    const full = imgRow ? resolveCreativeRel(imgRow.storage_rel_path) : null;
    if (!full) {
      res.status(404).json({ error: `Image asset missing for clip "${clip.name}".` });
      return;
    }
    slidePaths.push({ full, clip });
  }

  const musicRow = parsed.data.musicAssetId
    ? (db
        .prepare('SELECT storage_rel_path FROM creative_assets WHERE id = ? AND user_id = ?')
        .get(parsed.data.musicAssetId, user.id) as { storage_rel_path: string } | undefined)
    : undefined;
  const musicFull = musicRow ? resolveCreativeRel(musicRow.storage_rel_path) : null;

  const sfxRow = parsed.data.sfxAssetId
    ? (db
        .prepare('SELECT storage_rel_path FROM creative_assets WHERE id = ? AND user_id = ?')
        .get(parsed.data.sfxAssetId, user.id) as { storage_rel_path: string } | undefined)
    : undefined;
  const sfxFull = sfxRow ? resolveCreativeRel(sfxRow.storage_rel_path) : null;

  const dim =
    parsed.data.aspectRatio === '9:16'
      ? { w: 720, h: 1280 }
      : parsed.data.aspectRatio === '1:1'
      ? { w: 720, h: 720 }
      : { w: 1280, h: 720 };

  const fps = parsed.data.fps;
  const args: string[] = ['-y'];
  slidePaths.forEach((s) => {
    args.push('-i', s.full);
  });

  const voIdx = slidePaths.length;
  args.push('-i', voFull);
  let nextIdx = voIdx + 1;

  let musicIdx: number | null = null;
  if (musicFull) {
    musicIdx = nextIdx++;
    args.push('-stream_loop', '-1', '-i', musicFull);
  }

  let sfxIdx: number | null = null;
  if (sfxFull) {
    sfxIdx = nextIdx++;
    args.push('-i', sfxFull);
  }

  const filterParts: string[] = [];
  let totalVideoDur = 0;

  slidePaths.forEach((s, idx) => {
    const dur = Math.max(0.5, s.clip.durationSec);
    totalVideoDur += dur;
    const frames = Math.max(12, Math.round(dur * fps));
    const fadeDur = Math.min(0.35, dur / 3);
    const fadeOutStart = Math.max(0.05, Number((dur - fadeDur).toFixed(2)));

    let zoomExpr = `z='1.0':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    if (s.clip.motion === 'zoom_in') {
      zoomExpr = `z='min(zoom+0.0012,1.16)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    } else if (s.clip.motion === 'zoom_out') {
      zoomExpr = `z='if(lte(on,1),1.16,max(1.0,zoom-0.0012))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
    } else if (s.clip.motion === 'pan_left') {
      zoomExpr = `z='1.12':x='max(0,(iw-iw/zoom)*(1-on/${frames}))':y='ih/2-(ih/zoom/2)'`;
    } else if (s.clip.motion === 'pan_right') {
      zoomExpr = `z='1.12':x='min(iw-iw/zoom,(iw-iw/zoom)*(on/${frames}))':y='ih/2-(ih/zoom/2)'`;
    }

    const fadeFilter =
      s.clip.transition === 'fade' || s.clip.transition === 'wipe'
        ? `,fade=t=in:st=0:d=${fadeDur.toFixed(2)},fade=t=out:st=${fadeOutStart}:d=${fadeDur.toFixed(2)}`
        : '';

    filterParts.push(
      `[${idx}:v]scale=${dim.w}:${dim.h}:force_original_aspect_ratio=decrease,pad=${dim.w}:${dim.h}:(ow-iw)/2:(oh-ih)/2:color=#050706,setsar=1,zoompan=${zoomExpr}:d=${frames}:s=${dim.w}x${dim.h}:fps=${fps}${fadeFilter},format=yuv420p[v${idx}]`
    );
  });

  const concatInputs = slidePaths.map((_s, idx) => `[v${idx}]`).join('');
  filterParts.push(`${concatInputs}concat=n=${slidePaths.length}:v=1:a=0[vout]`);

  // Audio mix pipeline
  const audioLabels: string[] = [];
  filterParts.push(`[${voIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=1.0[vo]`);
  audioLabels.push('[vo]');

  if (musicIdx !== null) {
    filterParts.push(
      `[${musicIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=${parsed.data.musicVolume.toFixed(2)}[mus]`
    );
    audioLabels.push('[mus]');
  }
  if (sfxIdx !== null) {
    const delayMs = Math.max(0, Math.round(parsed.data.sfxStartSec * 1000));
    filterParts.push(
      `[${sfxIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delayMs}|${delayMs},volume=${parsed.data.sfxVolume.toFixed(
        2
      )}[sfx]`
    );
    audioLabels.push('[sfx]');
  }

  if (audioLabels.length === 1) {
    filterParts.push(`[vo]anull[aout]`);
  } else {
    filterParts.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=2[aout]`);
  }

  const projectId = crypto.randomUUID();
  const { rel: outRel, full: outFull } = safeUserCreativePath(user.id, `${projectId}.mp4`);

  args.push(
    '-filter_complex',
    filterParts.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-t',
    totalVideoDur.toFixed(2),
    '-movflags',
    '+faststart',
    outFull
  );

  try {
    await execFileAsync('ffmpeg', args, { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 });
    const measuredDuration = (await probeMediaDurationSec(outFull)) ?? totalVideoDur;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO creative_projects (
        id, user_id, project_id, kind, title, config_json, output_rel_path, mime_type, duration_sec, status, created_at, updated_at
      ) VALUES (?, ?, NULL, 'video_timeline', ?, ?, ?, 'video/mp4', ?, 'rendered', ?, ?)
    `).run(
      projectId,
      user.id,
      parsed.data.title,
      JSON.stringify(parsed.data),
      outRel,
      measuredDuration,
      now,
      now
    );

    recordAuditLog({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'creative_video_rendered',
      targetType: 'creative_project',
      targetId: projectId,
      outcome: 'success',
      detail: `Rendered MP4 (${slidePaths.length} clips, ${measuredDuration}s)`,
    });

    res.status(201).json({
      project: {
        id: projectId,
        userId: user.id,
        kind: 'video_timeline',
        title: parsed.data.title,
        config: parsed.data,
        outputDownloadUrl: `/api/v1/creative/projects/${projectId}/download`,
        mimeType: 'video/mp4',
        durationSec: measuredDuration,
        status: 'rendered',
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (err) {
    res.status(500).json({
      error: `FFmpeg rendering error: ${err instanceof Error ? err.message : 'Unable to encode MP4'}`,
    });
  }
});

creativeRouter.get('/projects/:id/download', (req: AuthenticatedRequest, res) => {
  const row = db
    .prepare('SELECT * FROM creative_projects WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.authUser!.id) as Record<string, unknown> | undefined;
  if (!row || !row.output_rel_path) {
    res.status(404).json({ error: 'Rendered media not found.' });
    return;
  }
  const full = resolveCreativeRel(String(row.output_rel_path));
  if (!full) {
    res.status(404).json({ error: 'Output binary missing on disk.' });
    return;
  }
  const safeName = String(row.title).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'loody-video';
  res.setHeader('Content-Type', String(row.mime_type ?? 'video/mp4'));
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp4"`);
  fs.createReadStream(full).pipe(res);
});

creativeRouter.post('/generate-brief', briefLimiter, async (req: AuthenticatedRequest, res) => {
  const schema = z.object({
    mode: z.enum(['storyboard', 'image_prompt', 'voice_script', 'svg_design']),
    brief: z.string().trim().min(4).max(3000),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Creative brief required.' });
    return;
  }

  const instructions: Record<string, string> = {
    storyboard:
      'You are LOODY Creative Studio Director. Generate a scene-by-scene animation/video storyboard table with timestamps, visual framing, camera motion, and voiceover narration.',
    image_prompt:
      'You are LOODY Image Studio Prompt Architect. Produce 3 detailed, style-calibrated art direction prompts, color palettes, lighting specs, and negative prompts.',
    voice_script:
      'You are LOODY Audio & Voice Producer. Write a crisp narration script with pacing cues ([pause 0.5s]), emphasis markers, and background SFX cues.',
    svg_design:
      'You are LOODY UI & Vector Designer. Output a short design spec followed by a clean standalone inline <svg viewBox="0 0 640 360">...</svg> artwork using a black and emerald color palette.',
  };

  try {
    const gen = await generateModelText({
      upstreamModelId: 'gemini-3.1-flash-lite',
      thinkingPreset: 'MEDIUM',
      systemInstruction: buildUnifiedSystemInstruction({
        surface: 'creative',
        modelId: 'sonic-3.5',
        modelDisplayName: 'Sonic 3.5',
        upstreamProvider: 'gemini',
        upstreamModelId: 'gemini-3.1-flash-lite',
        surfaceInstruction: instructions[parsed.data.mode],
      }),
      prompt: parsed.data.brief,
    });
    const reconciled = reconcileTokenRecord({
      providerReported: {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        cachedTokens: gen.cachedTokens,
      },
      fallbackInputText: parsed.data.brief,
      fallbackOutputText: gen.text,
    });
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO token_usage (
        id, user_id, conversation_id, model_id, provider, task_type,
        input_tokens, output_tokens, cached_tokens, accounting_type,
        estimated_cost_usd, usage_date, usage_month, created_at
      ) VALUES (?, ?, NULL, 'sonic-3.5', 'gemini', 'creative', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      req.authUser!.id,
      reconciled.inputTokens,
      reconciled.outputTokens,
      reconciled.cachedTokens,
      reconciled.accountingType,
      computeEstimatedCostUsd({
        provider: 'gemini',
        inputTokens: reconciled.inputTokens,
        outputTokens: reconciled.outputTokens,
        cachedTokens: reconciled.cachedTokens,
      }),
      now.slice(0, 10),
      now.slice(0, 7),
      now
    );

    res.json({ output: gen.text, tokens: reconciled });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Creative generation failed.' });
  }
});
