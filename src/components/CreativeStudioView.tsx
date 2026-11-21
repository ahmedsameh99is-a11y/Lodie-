import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Film,
  ImagePlus,
  Music,
  Volume2,
  Mic,
  Wand2,
  Play,
  Pause,
  Download,
  Trash2,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Layers,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { api } from '../lib/api';
import { getActiveFirebaseIdToken } from '../lib/firebase';
import type {
  CreativeAssetRecord,
  CreativeProjectRecord,
  PublicUser,
  VideoTimelineClip,
} from '../shared/types';

interface CreativeStudioViewProps {
  user: PublicUser | null;
  onOpenAuth: () => void;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export const CreativeStudioView: React.FC<CreativeStudioViewProps> = ({ user, onOpenAuth }) => {
  const [studioTab, setStudioTab] = useState<'video' | 'briefs'>('video');

  const [capabilities, setCapabilities] = useState<{
    ffmpegAvailable: boolean;
    videoRenderingReady: boolean;
    imageGenerationPaidApiConfigured: boolean;
    imageGenerationStatus: string;
  } | null>(null);
  const [assets, setAssets] = useState<CreativeAssetRecord[]>([]);
  const [projects, setProjects] = useState<CreativeProjectRecord[]>([]);

  // Video Timeline Studio State
  const [projectTitle, setProjectTitle] = useState('LOODY Narrative Cut');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [fps, setFps] = useState<24 | 30>(24);
  const [voiceoverId, setVoiceoverId] = useState<string>('');
  const [musicId, setMusicId] = useState<string>('');
  const [musicVolume, setMusicVolume] = useState<number>(0.25);
  const [sfxId, setSfxId] = useState<string>('');
  const [sfxStartSec, setSfxStartSec] = useState<number>(0);
  const [sfxVolume, setSfxVolume] = useState<number>(0.75);
  const [clips, setClips] = useState<VideoTimelineClip[]>([]);
  const [uploading, setUploading] = useState(false);
  const [rendering, setRendering] = useState(false);

  // Synced Preview Player State
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const previewTimerRef = useRef<number | null>(null);
  const voAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const sfxAudioRef = useRef<HTMLAudioElement | null>(null);
  const sfxPlayedRef = useRef(false);

  // Rendered Video Playback + Authenticated Object URLs
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [renderedVideoBlobUrl, setRenderedVideoBlobUrl] = useState<string | null>(null);
  const [renderedProject, setRenderedProject] = useState<CreativeProjectRecord | null>(null);

  // Creative Brief & SVG Generator
  const [briefMode, setBriefMode] = useState<'storyboard' | 'image_prompt' | 'voice_script' | 'svg_design'>('storyboard');
  const [briefText, setBriefText] = useState('');
  const [briefOutput, setBriefOutput] = useState<string | null>(null);
  const [generatingBrief, setGeneratingBrief] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const fetchAuthenticatedBlobUrl = async (downloadPath: string): Promise<string> => {
    const token = await getActiveFirebaseIdToken();
    const resp = await fetch(downloadPath, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) throw new Error('Failed to load media stream.');
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  };

  const loadAll = async () => {
    if (!user) return;
    try {
      const [capRes, assetRes, projRes] = await Promise.all([
        api.getCreativeCapabilities(),
        api.getCreativeAssets(),
        api.getCreativeProjects(),
      ]);
      setCapabilities(capRes);
      setAssets(assetRes.assets);
      setProjects(projRes.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Creative Studio.');
    }
  };

  useEffect(() => {
    loadAll();
  }, [user?.id]);

  // Populate authenticated object URLs for previewing image & audio assets smoothly
  useEffect(() => {
    let active = true;
    const ensureUrls = async () => {
      for (const a of assets) {
        if (!assetUrls[a.id]) {
          try {
            const url = await fetchAuthenticatedBlobUrl(a.downloadUrl);
            if (active) {
              setAssetUrls((prev) => ({ ...prev, [a.id]: url }));
            }
          } catch {
            // Skip unreachable
          }
        }
      }
    };
    if (assets.length > 0) ensureUrls();
    return () => {
      active = false;
    };
  }, [assets]);

  const imageAssets = useMemo(() => assets.filter((a) => a.kind === 'image'), [assets]);
  const voiceoverAssets = useMemo(() => assets.filter((a) => a.kind === 'audio'), [assets]);
  const musicAssets = useMemo(() => assets.filter((a) => a.kind === 'music' || a.kind === 'audio'), [assets]);
  const sfxAssets = useMemo(() => assets.filter((a) => a.kind === 'sfx' || a.kind === 'audio'), [assets]);

  const selectedVoiceover = voiceoverAssets.find((v) => v.id === voiceoverId) ?? null;
  const totalTimelineSec = useMemo(
    () => clips.reduce((sum, c) => sum + c.durationSec, 0),
    [clips]
  );

  // Stop preview on unmount
  useEffect(() => {
    return () => {
      if (previewTimerRef.current) window.clearInterval(previewTimerRef.current);
    };
  }, []);

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Film className="w-10 h-10 text-emerald-500 mx-auto" />
        <h2 className="mt-4 font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Creative & Video Studio</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to upload images, voiceovers, music, and SFX, auto-synchronize timelines, preview motion transitions, and export real FFmpeg MP4 videos.
        </p>
        <button
          type="button"
          onClick={onOpenAuth}
          className="mt-6 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-500 min-h-[44px] cursor-pointer"
        >
          Sign In
        </button>
      </div>
    );
  }

  const handleUploadFiles = async (kind: 'image' | 'audio' | 'music' | 'sfx', fileList: FileList | null) => {
    if (!fileList?.length) return;
    setUploading(true);
    setError(null);
    setStatusMsg(null);
    const uploadedImageIds: string[] = [];
    let uploadedVoId = voiceoverId;

    try {
      for (const file of Array.from(fileList)) {
        if (file.size > 12 * 1024 * 1024) {
          setError(`${file.name} exceeds 12MB upload limit.`);
          continue;
        }
        const dataBase64 = await readFileAsBase64(file);
        const res = await api.uploadCreativeAsset({
          kind,
          name: file.name,
          mimeType: file.type || (kind === 'image' ? 'image/png' : 'audio/wav'),
          dataBase64,
        });
        if (kind === 'image') uploadedImageIds.push(res.asset.id);
        if (kind === 'audio') {
          uploadedVoId = res.asset.id;
          setVoiceoverId(res.asset.id);
        }
        if (kind === 'music') setMusicId(res.asset.id);
        if (kind === 'sfx') setSfxId(res.asset.id);
      }

      await loadAll();
      if (uploadedImageIds.length > 0 && clips.length === 0) {
        const autoRes = await api.autoBuildVideoTimeline({
          voiceoverAssetId: uploadedVoId || null,
          imageAssetIds: uploadedImageIds,
        });
        setClips(autoRes.clips);
      }
      setStatusMsg(`Uploaded ${fileList.length} ${kind} asset(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Asset upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleAutoSynchronizeTimeline = async () => {
    if (imageAssets.length === 0) {
      setError('Upload at least one image first.');
      return;
    }
    setError(null);
    try {
      const targetIds = clips.length > 0 ? clips.map((c) => c.assetId) : imageAssets.map((img) => img.id);
      const res = await api.autoBuildVideoTimeline({
        voiceoverAssetId: voiceoverId || null,
        imageAssetIds: targetIds,
      });
      setClips(res.clips);
      setStatusMsg(`Synchronized ${res.clips.length} visual clips to ${res.durationSec.toFixed(2)}s timeline.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to synchronize timeline.');
    }
  };

  const handleTogglePreview = () => {
    if (previewPlaying) {
      if (previewTimerRef.current) window.clearInterval(previewTimerRef.current);
      previewTimerRef.current = null;
      voAudioRef.current?.pause();
      musicAudioRef.current?.pause();
      sfxAudioRef.current?.pause();
      setPreviewPlaying(false);
      return;
    }

    if (clips.length === 0) return;
    const maxSec = Math.max(totalTimelineSec, selectedVoiceover?.durationSec ?? 0, 1);
    setPlayheadSec(0);
    sfxPlayedRef.current = false;

    if (voAudioRef.current && voiceoverId) {
      voAudioRef.current.currentTime = 0;
      voAudioRef.current.play().catch(() => null);
    }
    if (musicAudioRef.current && musicId) {
      musicAudioRef.current.volume = Math.min(1, Math.max(0, musicVolume));
      musicAudioRef.current.currentTime = 0;
      musicAudioRef.current.play().catch(() => null);
    }

    setPreviewPlaying(true);
    const startTs = performance.now();
    previewTimerRef.current = window.setInterval(() => {
      const elapsed = (performance.now() - startTs) / 1000;
      if (sfxAudioRef.current && sfxId && !sfxPlayedRef.current && elapsed >= sfxStartSec) {
        sfxPlayedRef.current = true;
        sfxAudioRef.current.volume = Math.min(1, Math.max(0, sfxVolume));
        sfxAudioRef.current.currentTime = 0;
        sfxAudioRef.current.play().catch(() => null);
      }
      if (elapsed >= maxSec) {
        if (previewTimerRef.current) window.clearInterval(previewTimerRef.current);
        previewTimerRef.current = null;
        voAudioRef.current?.pause();
        musicAudioRef.current?.pause();
        sfxAudioRef.current?.pause();
        setPreviewPlaying(false);
        setPlayheadSec(0);
      } else {
        setPlayheadSec(elapsed);
      }
    }, 60);
  };

  const handleRenderMp4 = async () => {
    if (!voiceoverId) {
      setError('Select or upload an original voiceover audio file before exporting MP4.');
      return;
    }
    if (clips.length === 0) {
      setError('Add or synchronize at least one image clip on the timeline.');
      return;
    }
    setRendering(true);
    setError(null);
    setStatusMsg('Encoding H.264/AAC MP4 via FFmpeg on server...');
    try {
      const res = await api.renderCreativeVideo({
        title: projectTitle.trim() || 'LOODY Studio Video',
        aspectRatio,
        fps,
        voiceoverAssetId: voiceoverId,
        musicAssetId: musicId || null,
        musicVolume,
        sfxAssetId: sfxId || null,
        sfxStartSec,
        sfxVolume,
        clips,
      });
      setRenderedProject(res.project);
      if (res.project.outputDownloadUrl) {
        const blobUrl = await fetchAuthenticatedBlobUrl(res.project.outputDownloadUrl);
        setRenderedVideoBlobUrl(blobUrl);
      }
      setStatusMsg(`MP4 rendered (${res.project.durationSec?.toFixed(2) ?? ''}s). Ready for playback and download.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MP4 export failed.');
      setStatusMsg(null);
    } finally {
      setRendering(false);
    }
  };

  const handleDownloadMp4 = async (proj: CreativeProjectRecord) => {
    if (!proj.outputDownloadUrl) return;
    try {
      const blobUrl =
        renderedProject?.id === proj.id && renderedVideoBlobUrl
          ? renderedVideoBlobUrl
          : await fetchAuthenticatedBlobUrl(proj.outputDownloadUrl);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${proj.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'loody-video'}.mp4`;
      a.click();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to download MP4 file.');
    }
  };

  const activePreviewClip =
    clips.find((c) => playheadSec >= c.startSec && playheadSec < c.startSec + c.durationSec) ?? clips[0] ?? null;

  const moveClip = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= clips.length) return;
    const next = [...clips];
    [next[idx], next[target]] = [next[target], next[idx]];
    let cursor = 0;
    setClips(
      next.map((c) => {
        const updated = { ...c, startSec: Number(cursor.toFixed(2)) };
        cursor += c.durationSec;
        return updated;
      })
    );
  };

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-200 dark:border-white/10 pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold text-zinc-900 dark:text-white">LOODY Creative & Video Studio</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Synchronized multi-image + multi-track audio timeline powered by server-side FFmpeg H.264/AAC MP4 export.
          </p>
        </div>

        <div className="flex rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-100 dark:bg-[#0A0E0C] p-1 w-fit">
          {[
            { id: 'video', label: 'Video & Timeline Studio' },
            { id: 'briefs', label: 'Storyboards, Prompts & SVG' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setStudioTab(item.id as typeof studioTab)}
              className={`rounded-lg px-3.5 py-2 text-xs font-medium min-h-[38px] cursor-pointer ${
                studioTab === item.id ? 'bg-emerald-600 text-white' : 'text-zinc-600 dark:text-zinc-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Capability Status Disclosure */}
      {capabilities && (
        <div className="rounded-xl border border-emerald-500/20 bg-white dark:bg-[#0D110F] px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className={`w-4 h-4 ${capabilities.ffmpegAvailable ? 'text-emerald-500' : 'text-amber-500'}`} />
            <span className="font-medium text-zinc-800 dark:text-zinc-200">
              FFmpeg MP4 Renderer: {capabilities.ffmpegAvailable ? 'Ready (H.264 + AAC)' : 'Unavailable'}
            </span>
          </div>
          <span className="text-[11px] text-zinc-500">{capabilities.imageGenerationStatus}</span>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {statusMsg && (
        <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs text-emerald-800 dark:text-emerald-200">
          {statusMsg}
        </div>
      )}

      {studioTab === 'video' && (
        <div className="space-y-6">
          {/* Hidden HTML Audio Elements for Real Synced Preview Playback */}
          {voiceoverId && assetUrls[voiceoverId] && (
            <audio ref={voAudioRef} src={assetUrls[voiceoverId]} preload="auto" />
          )}
          {musicId && assetUrls[musicId] && (
            <audio ref={musicAudioRef} src={assetUrls[musicId]} loop preload="auto" />
          )}
          {sfxId && assetUrls[sfxId] && (
            <audio ref={sfxAudioRef} src={assetUrls[sfxId]} preload="auto" />
          )}

          {/* Top 3-Column Studio Grid: Asset Uploader | Preview Player | Audio Tracks & Export */}
          <div className="grid gap-5 lg:grid-cols-12">
            {/* Left: Upload & Asset Library */}
            <div className="lg:col-span-4 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-sm font-bold text-zinc-900 dark:text-white">Media Assets</h3>
                <span className="text-[11px] font-mono text-zinc-500">{assets.length} uploaded</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2.5 font-medium text-emerald-700 dark:text-emerald-300 cursor-pointer hover:bg-emerald-500/20">
                  <ImagePlus className="w-4 h-4" />
                  <span>{uploading ? 'Uploading...' : 'Add Images'}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    aria-label="Upload multiple images"
                    className="hidden"
                    onChange={(e) => {
                      handleUploadFiles('image', e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>

                <label className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/15 bg-zinc-50 dark:bg-[#050706] px-3 py-2.5 font-medium text-zinc-800 dark:text-zinc-200 cursor-pointer hover:border-emerald-500/40">
                  <Mic className="w-4 h-4 text-emerald-500" />
                  <span>Voiceover</span>
                  <input
                    type="file"
                    accept="audio/*"
                    aria-label="Upload voiceover file"
                    className="hidden"
                    onChange={(e) => {
                      handleUploadFiles('audio', e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>

                <label className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/15 bg-zinc-50 dark:bg-[#050706] px-3 py-2.5 font-medium text-zinc-800 dark:text-zinc-200 cursor-pointer hover:border-emerald-500/40">
                  <Music className="w-4 h-4 text-emerald-500" />
                  <span>Music Track</span>
                  <input
                    type="file"
                    accept="audio/*"
                    aria-label="Upload background music"
                    className="hidden"
                    onChange={(e) => {
                      handleUploadFiles('music', e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>

                <label className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/15 bg-zinc-50 dark:bg-[#050706] px-3 py-2.5 font-medium text-zinc-800 dark:text-zinc-200 cursor-pointer hover:border-emerald-500/40">
                  <Volume2 className="w-4 h-4 text-emerald-500" />
                  <span>SFX Clip</span>
                  <input
                    type="file"
                    accept="audio/*"
                    aria-label="Upload sound effect"
                    className="hidden"
                    onChange={(e) => {
                      handleUploadFiles('sfx', e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>

              {/* Asset List */}
              <div className="space-y-1.5 max-h-60 overflow-y-auto text-xs">
                {assets.length === 0 ? (
                  <p className="py-4 text-center text-zinc-500">Upload images + 1 voiceover file to build your synchronized timeline.</p>
                ) : (
                  assets.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-zinc-900 dark:text-white truncate">{a.name}</div>
                        <div className="text-[11px] font-mono text-zinc-500">
                          {a.kind} {a.durationSec ? `· ${a.durationSec.toFixed(2)}s` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {a.kind === 'image' && (
                          <button
                            type="button"
                            onClick={() => {
                              const start = clips.reduce((s, c) => s + c.durationSec, 0);
                              setClips((prev) => [
                                ...prev,
                                {
                                  id: `clip-${Date.now()}-${prev.length}`,
                                  assetId: a.id,
                                  name: a.name,
                                  startSec: Number(start.toFixed(2)),
                                  durationSec: 3,
                                  motion: 'zoom_in',
                                  transition: 'fade',
                                },
                              ]);
                            }}
                            className="rounded-lg border border-emerald-500/30 px-2 py-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 cursor-pointer"
                          >
                            + Clip
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`Delete asset ${a.name}`}
                          onClick={async () => {
                            await api.deleteCreativeAsset(a.id);
                            setClips((prev) => prev.filter((c) => c.assetId !== a.id));
                            await loadAll();
                          }}
                          className="p-1 text-zinc-400 hover:text-red-500 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Center: Interactive Synced Preview Player + Exported MP4 Video */}
            <div className="lg:col-span-4 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 flex flex-col justify-between space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-sm font-bold text-zinc-900 dark:text-white">Preview Player</h3>
                <span className="font-mono text-[11px] text-emerald-500 tabular-nums">
                  {playheadSec.toFixed(1)}s / {Math.max(totalTimelineSec, selectedVoiceover?.durationSec ?? 0).toFixed(1)}s
                </span>
              </div>

              <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-zinc-200 dark:border-white/10 bg-[#050706] flex items-center justify-center">
                {activePreviewClip && assetUrls[activePreviewClip.assetId] ? (
                  <img
                    src={assetUrls[activePreviewClip.assetId]}
                    alt={activePreviewClip.name}
                    className={`h-full w-full object-contain transition-transform duration-700 ${
                      previewPlaying && activePreviewClip.motion === 'zoom_in'
                        ? 'scale-110'
                        : previewPlaying && activePreviewClip.motion === 'pan_right'
                        ? 'translate-x-2 scale-105'
                        : previewPlaying && activePreviewClip.motion === 'pan_left'
                        ? '-translate-x-2 scale-105'
                        : 'scale-100'
                    }`}
                  />
                ) : (
                  <div className="text-center px-4 text-xs text-zinc-500">
                    Add images & voiceover to preview synchronized slide motion and audio mix.
                  </div>
                )}

                {activePreviewClip && (
                  <div className="absolute bottom-2 left-2 rounded-lg bg-black/70 px-2 py-1 text-[10px] font-mono text-emerald-300">
                    {activePreviewClip.name} · {activePreviewClip.motion}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={clips.length === 0}
                  onClick={handleTogglePreview}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 cursor-pointer"
                >
                  {previewPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  <span>{previewPlaying ? 'Stop Preview' : 'Play Synced Preview'}</span>
                </button>
                <button
                  type="button"
                  disabled={imageAssets.length === 0}
                  onClick={handleAutoSynchronizeTimeline}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-white/10 px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:border-emerald-500/40 disabled:opacity-40 cursor-pointer"
                >
                  <Wand2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Auto-Sync</span>
                </button>
              </div>
            </div>

            {/* Right: Audio Track Controls + Export MP4 */}
            <div className="lg:col-span-4 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-4 space-y-3 text-xs">
              <h3 className="font-display text-sm font-bold text-zinc-900 dark:text-white">Audio Tracks & MP4 Export</h3>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="vid-title" className="block text-[11px] text-zinc-500 mb-1">Project Title</label>
                  <input
                    id="vid-title"
                    type="text"
                    value={projectTitle}
                    onChange={(e) => setProjectTitle(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2.5 py-1.5 text-zinc-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="vid-ratio" className="block text-[11px] text-zinc-500 mb-1">Aspect Ratio & FPS</label>
                  <div className="flex gap-1">
                    <select
                      id="vid-ratio"
                      value={aspectRatio}
                      onChange={(e) => setAspectRatio(e.target.value as typeof aspectRatio)}
                      className="flex-1 rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2 py-1.5 text-zinc-900 dark:text-white"
                    >
                      <option value="16:9">16:9</option>
                      <option value="9:16">9:16</option>
                      <option value="1:1">1:1</option>
                    </select>
                    <select
                      aria-label="Frame rate FPS"
                      value={fps}
                      onChange={(e) => setFps(Number(e.target.value) as 24 | 30)}
                      className="rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2 py-1.5 text-zinc-900 dark:text-white"
                    >
                      <option value={24}>24fps</option>
                      <option value={30}>30fps</option>
                    </select>
                  </div>
                </div>
              </div>

              <div>
                <label htmlFor="vo-select" className="block text-[11px] text-zinc-500 mb-1">
                  Original Voiceover Track (Required)
                </label>
                <select
                  id="vo-select"
                  value={voiceoverId}
                  onChange={(e) => setVoiceoverId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2.5 py-2 text-zinc-900 dark:text-white"
                >
                  <option value="">Select voiceover audio...</option>
                  {voiceoverAssets.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.durationSec ? `${v.durationSec.toFixed(2)}s` : 'probed'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2 items-end">
                <div className="col-span-2">
                  <label htmlFor="mus-select" className="block text-[11px] text-zinc-500 mb-1">Music Track (Optional)</label>
                  <select
                    id="mus-select"
                    value={musicId}
                    onChange={(e) => setMusicId(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2.5 py-1.5 text-zinc-900 dark:text-white"
                  >
                    <option value="">No Background Music</option>
                    {musicAssets.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="mus-vol" className="block text-[11px] text-zinc-500 mb-1">Vol ({Math.round(musicVolume * 100)}%)</label>
                  <input
                    id="mus-vol"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={musicVolume}
                    onChange={(e) => setMusicVolume(Number(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2 items-end">
                <div className="col-span-2">
                  <label htmlFor="sfx-select" className="block text-[11px] text-zinc-500 mb-1">SFX Track</label>
                  <select
                    id="sfx-select"
                    value={sfxId}
                    onChange={(e) => setSfxId(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2 py-1.5 text-zinc-900 dark:text-white"
                  >
                    <option value="">No SFX</option>
                    {sfxAssets.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="sfx-start" className="block text-[11px] text-zinc-500 mb-1">Start (s)</label>
                  <input
                    id="sfx-start"
                    type="number"
                    min={0}
                    step={0.5}
                    value={sfxStartSec}
                    onChange={(e) => setSfxStartSec(Number(e.target.value))}
                    className="w-full rounded-lg border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] px-2 py-1.5 text-zinc-900 dark:text-white"
                  />
                </div>
                <div>
                  <label htmlFor="sfx-vol" className="block text-[11px] text-zinc-500 mb-1">Vol</label>
                  <input
                    id="sfx-vol"
                    type="range"
                    min={0}
                    max={1.2}
                    step={0.05}
                    value={sfxVolume}
                    onChange={(e) => setSfxVolume(Number(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={rendering || !voiceoverId || clips.length === 0}
                onClick={handleRenderMp4}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer"
              >
                <Film className="w-4 h-4" />
                <span>{rendering ? 'Rendering Playable MP4...' : 'Export Final MP4'}</span>
              </button>
            </div>
          </div>

          {/* Visible Synchronized Multi-Track Timeline */}
          <section className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-emerald-500" />
                <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">
                  Synchronized Timeline ({clips.length} Visual Clips · {totalTimelineSec.toFixed(2)}s)
                </h3>
              </div>
              {selectedVoiceover?.durationSec && (
                <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                  Voiceover Duration: {selectedVoiceover.durationSec.toFixed(2)}s
                </span>
              )}
            </div>

            {clips.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 dark:border-white/15 p-6 text-center text-xs text-zinc-500">
                Upload images & voiceover above, then click Auto-Sync to arrange all images across the voiceover duration.
              </div>
            ) : (
              <div className="space-y-3">
                {/* Visual Track Strip */}
                <div className="space-y-2">
                  {clips.map((clip, idx) => (
                    <div
                      key={clip.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 text-xs"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {assetUrls[clip.assetId] && (
                          <img src={assetUrls[clip.assetId]} alt={clip.name} className="h-10 w-16 rounded-lg object-cover border border-zinc-200 dark:border-white/10 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold text-zinc-900 dark:text-white truncate">
                            #{idx + 1} · {clip.name}
                          </div>
                          <div className="font-mono text-[11px] text-zinc-500">
                            {clip.startSec.toFixed(2)}s → {(clip.startSec + clip.durationSec).toFixed(2)}s
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="number"
                          aria-label={`Duration for ${clip.name}`}
                          min={0.5}
                          max={120}
                          step={0.25}
                          value={clip.durationSec}
                          onChange={(e) => {
                            const val = Math.max(0.5, Number(e.target.value) || 0.5);
                            let cursor = 0;
                            setClips((prev) =>
                              prev.map((c, cIdx) => {
                                const dur = cIdx === idx ? val : c.durationSec;
                                const updated = { ...c, startSec: Number(cursor.toFixed(2)), durationSec: dur };
                                cursor += dur;
                                return updated;
                              })
                            );
                          }}
                          className="w-20 rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2 py-1 text-xs font-mono"
                        />
                        <select
                          aria-label={`Motion for ${clip.name}`}
                          value={clip.motion}
                          onChange={(e) =>
                            setClips((prev) =>
                              prev.map((c, cIdx) => (cIdx === idx ? { ...c, motion: e.target.value as VideoTimelineClip['motion'] } : c))
                            )
                          }
                          className="rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2 py-1 text-xs"
                        >
                          <option value="zoom_in">Zoom In</option>
                          <option value="zoom_out">Zoom Out</option>
                          <option value="pan_left">Pan Left</option>
                          <option value="pan_right">Pan Right</option>
                          <option value="none">Static</option>
                        </select>
                        <select
                          aria-label={`Transition for ${clip.name}`}
                          value={clip.transition}
                          onChange={(e) =>
                            setClips((prev) =>
                              prev.map((c, cIdx) =>
                                cIdx === idx ? { ...c, transition: e.target.value as VideoTimelineClip['transition'] } : c
                              )
                            )
                          }
                          className="rounded-lg border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] px-2 py-1 text-xs"
                        >
                          <option value="fade">Fade</option>
                          <option value="wipe">Wipe</option>
                          <option value="none">Cut</option>
                        </select>
                        <button type="button" aria-label="Move clip earlier" onClick={() => moveClip(idx, -1)} className="p-1 text-zinc-500 hover:text-emerald-500 cursor-pointer">
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" aria-label="Move clip later" onClick={() => moveClip(idx, 1)} className="p-1 text-zinc-500 hover:text-emerald-500 cursor-pointer">
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove clip ${clip.name}`}
                          onClick={() => setClips((prev) => prev.filter((_, cIdx) => cIdx !== idx))}
                          className="p-1 text-zinc-500 hover:text-red-500 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Rendered Playable MP4 Output & Export History */}
          {(renderedVideoBlobUrl || projects.length > 0) && (
            <section className="rounded-2xl border border-emerald-500/30 bg-white dark:bg-[#0D110F] p-5 space-y-4">
              <h3 className="font-display text-base font-bold text-zinc-900 dark:text-white">Rendered Playable MP4 Exports</h3>

              {renderedVideoBlobUrl && renderedProject && (
                <div className="grid gap-4 md:grid-cols-2 items-center">
                  <video src={renderedVideoBlobUrl} controls className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-black" />
                  <div className="space-y-3 text-xs">
                    <div className="font-display text-base font-bold text-emerald-600 dark:text-emerald-400">
                      {renderedProject.title}
                    </div>
                    <div className="font-mono text-zinc-500">
                      Format: video/mp4 (H.264 + AAC) · Duration: {renderedProject.durationSec?.toFixed(2)}s
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDownloadMp4(renderedProject)}
                      className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download Final MP4</span>
                    </button>
                  </div>
                </div>
              )}

              {projects.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                  {projects.map((p) => (
                    <div key={p.id} className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-zinc-900 dark:text-white truncate">{p.title}</div>
                        <div className="font-mono text-[11px] text-zinc-500">
                          {p.status} · {p.durationSec ? `${p.durationSec.toFixed(2)}s` : ''}
                        </div>
                      </div>
                      {p.outputDownloadUrl && (
                        <button
                          type="button"
                          onClick={() => handleDownloadMp4(p)}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/35 px-2.5 py-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 cursor-pointer shrink-0"
                        >
                          <Download className="w-3 h-3" />
                          <span>MP4</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {studioTab === 'briefs' && (
        <div className="rounded-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#0D110F] p-5 space-y-4">
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'storyboard', label: 'Animation & Video Storyboard' },
              { id: 'image_prompt', label: 'Image Prompt Architect' },
              { id: 'voice_script', label: 'Audio Voiceover & SFX Script' },
              { id: 'svg_design', label: 'Vector & UI SVG Generator' },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setBriefMode(m.id as typeof briefMode)}
                className={`rounded-xl border px-3 py-2 text-xs font-medium cursor-pointer ${
                  briefMode === m.id
                    ? 'border-emerald-500 bg-emerald-600 text-white'
                    : 'border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!briefText.trim()) return;
              setGeneratingBrief(true);
              setError(null);
              try {
                const res = await api.generateCreativeBrief({ mode: briefMode, brief: briefText.trim() });
                setBriefOutput(res.output);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Creative generation failed.');
              } finally {
                setGeneratingBrief(false);
              }
            }}
            className="space-y-3"
          >
            <textarea
              rows={3}
              required
              aria-label="Creative brief description"
              value={briefText}
              onChange={(e) => setBriefText(e.target.value)}
              placeholder="Describe the scene, visual concept, voiceover tone, or geometric SVG card to produce..."
              className="w-full rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-3 text-xs text-zinc-900 dark:text-white"
            />
            <button
              type="submit"
              disabled={generatingBrief || !briefText.trim()}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{generatingBrief ? 'Generating...' : 'Generate Creative Deliverable'}</span>
            </button>
          </form>

          {briefOutput && (
            <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-[#050706] p-4 text-xs whitespace-pre-wrap leading-relaxed text-zinc-800 dark:text-zinc-200">
              {briefOutput}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
