import React, { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, ArrowRight } from 'lucide-react';
import type { AppLanguage } from '../shared/types';
import { t } from '../shared/i18n';
import { LoodyLogo } from './LoodyLogo';

interface SplashScreenProps {
  language: AppLanguage;
  soundEnabled: boolean;
  reducedMotion: boolean;
  isReplay?: boolean;
  onComplete: (markFirstLaunchDone: boolean) => void;
}

export function playLoodyChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.001, now);
    master.gain.exponentialRampToValueAtTime(0.14, now + 0.06);
    master.gain.exponentialRampToValueAtTime(0.0008, now + 1.15);
    master.connect(ctx.destination);

    // Original harmonic emerald triad: E4 (329.63Hz) -> B4 (493.88Hz) -> F#5 (739.99Hz)
    const freqs = [329.63, 493.88, 739.99];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.08);
      gain.gain.setValueAtTime(0.001, now + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.35 / (i + 1), now + i * 0.08 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + i * 0.08);
      osc.stop(now + 1.15);
    });
  } catch {
    // Browser autoplay policy blocked audio; never throw or force playback
  }
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  language,
  soundEnabled,
  reducedMotion,
  isReplay = false,
  onComplete,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stage, setStage] = useState<'particles' | 'emblem' | 'tagline'>(reducedMotion ? 'tagline' : 'particles');
  const [soundPlayed, setSoundPlayed] = useState(false);

  useEffect(() => {
    if (reducedMotion) {
      setStage('tagline');
      return;
    }
    const t1 = window.setTimeout(() => setStage('emblem'), 450);
    const t2 = window.setTimeout(() => setStage('tagline'), 1100);
    // Auto-complete gracefully after 3.4s if user hasn't already clicked Enter/Skip
    const t3 = window.setTimeout(() => {
      onComplete(true);
    }, 3600);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [reducedMotion, onComplete]);

  // Lightweight 2D particle field with 3D depth projection (mobile battery safe)
  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    };
    resize();
    window.addEventListener('resize', resize);

    const particles = Array.from({ length: 28 }, (_, i) => ({
      x: (Math.sin(i * 12.9898) * 0.5 + 0.5) * canvas.width,
      y: (Math.cos(i * 78.233) * 0.5 + 0.5) * canvas.height,
      vx: ((i % 3) - 1) * 0.35 * dpr,
      vy: (-0.25 - (i % 4) * 0.12) * dpr,
      radius: (1.2 + (i % 3) * 0.9) * dpr,
      alpha: 0.25 + (i % 5) * 0.12,
    }));

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.y < -10) p.y = canvas.height + 10;
        if (p.x < -10) p.x = canvas.width + 10;
        if (p.x > canvas.width + 10) p.x = -10;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(52, 211, 153, ${p.alpha})`;
        ctx.fill();
      }
      rafId = window.requestAnimationFrame(draw);
    };
    rafId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    };
  }, [reducedMotion]);

  const handleEnter = (playSound: boolean) => {
    if (playSound && soundEnabled && !soundPlayed && (!isReplay || isReplay)) {
      const alreadyPlayedOnFirst = localStorage.getItem('loody_intro_sound_played') === '1';
      if (!alreadyPlayedOnFirst || isReplay) {
        playLoodyChime();
        setSoundPlayed(true);
        localStorage.setItem('loody_intro_sound_played', '1');
      }
    }
    onComplete(true);
  };

  return (
    <div
      data-testid="splash-screen"
      className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-[#050706] px-6 py-8 text-[#F1F5F3] overflow-hidden"
    >
      {/* Background emerald particle field */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {/* Subtle top-right Skip button (always accessible immediately) */}
      <div className="relative z-10 flex w-full max-w-4xl items-center justify-between">
        <span className="text-xs font-mono tracking-wider text-emerald-400/80">
          LOODY OS
        </span>
        <button
          type="button"
          onClick={() => onComplete(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-[#0D110F]/90 px-4 py-2 text-xs font-medium text-zinc-200 hover:border-emerald-400/50 hover:text-white transition-colors min-h-[44px] cursor-pointer"
        >
          <span>{t(language, 'skipIntro')}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Center 3D Perspective Emblem Convergence */}
      <div className="relative z-10 flex flex-col items-center text-center">
        <div
          className="relative flex items-center justify-center"
          style={{ perspective: '900px' }}
        >
          {/* Abstract 3D Emerald Planes converging */}
          {!reducedMotion && (
            <>
              <div
                aria-hidden="true"
                className={`absolute h-36 w-36 rounded-2xl border border-emerald-500/30 bg-emerald-950/20 transition-all duration-700 ease-out ${
                  stage === 'particles'
                    ? 'scale-150 opacity-0 rotate-45'
                    : 'scale-100 opacity-100 rotate-12'
                }`}
                style={{ transform: stage === 'particles' ? 'rotateX(55deg) rotateZ(45deg) scale(1.4)' : 'rotateX(22deg) rotateY(-18deg) scale(1)' }}
              />
              <div
                aria-hidden="true"
                className={`absolute h-28 w-28 rounded-2xl border border-emerald-400/20 transition-all duration-700 delay-100 ease-out ${
                  stage === 'particles' ? 'scale-50 opacity-0' : 'scale-100 opacity-100'
                }`}
                style={{ transform: 'rotateX(-18deg) rotateY(20deg)' }}
              />
            </>
          )}

          {/* Official Concept A Emblem */}
          <div
            className={`relative transition-all duration-700 ease-out ${
              stage === 'particles'
                ? 'scale-75 opacity-0 translate-y-4'
                : 'scale-100 opacity-100 translate-y-0'
            }`}
          >
            <LoodyLogo variant="splash-3d" size={112} />
          </div>
        </div>

        {/* Wordmark & Tagline */}
        <h1
          className={`mt-7 font-display text-4xl sm:text-5xl font-bold tracking-tight text-white transition-all duration-500 ${
            stage === 'particles' ? 'opacity-0 translate-y-3' : 'opacity-100 translate-y-0'
          }`}
        >
          LOODY
        </h1>
        <p
          className={`mt-2.5 text-base sm:text-lg text-emerald-300/90 transition-all duration-500 delay-150 ${
            stage === 'tagline' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
          }`}
        >
          {t(language, 'tagline')}
        </p>
      </div>

      {/* Bottom Gesture-Safe Enter + Audio Trigger */}
      <div className="relative z-10 flex flex-wrap items-center justify-center gap-3 pb-safe">
        <button
          type="button"
          onClick={() => handleEnter(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-500 transition-colors min-h-[44px] cursor-pointer"
        >
          {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          <span>{t(language, 'enterWorkspace')}</span>
        </button>
      </div>
    </div>
  );
};
