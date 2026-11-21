import React, { useId } from 'react';
import { LOODY_L_PATHS, LOODY_L_VIEWBOX, type LoodyLogoVariant } from '../shared/logoGeometry';

interface LoodyLogoProps {
  variant?: LoodyLogoVariant;
  size?: number;
  className?: string;
  monochromeColor?: string;
}

/**
 * Official LOODY Capital "L" Logo — Concept A
 * Uses identical shared geometric coordinates across all 6 variants.
 */
export const LoodyLogo: React.FC<LoodyLogoProps> = ({
  variant = 'primary-3d',
  size = 40,
  className = '',
  monochromeColor = '#F1F5F3',
}) => {
  const uid = useId().replace(/:/g, '');
  const bgId = `loody-bg-${uid}`;
  const frontId = `loody-front-${uid}`;
  const depthId = `loody-depth-${uid}`;
  const glowId = `loody-glow-${uid}`;

  const isMonochrome = variant === 'monochrome';
  const isFlat = variant === 'flat-2d';
  const isTransparent = variant === 'transparent-3d' || variant === 'splash-3d';
  const isAndroid = variant === 'android-icon';

  return (
    <svg
      width={size}
      height={size}
      viewBox={LOODY_L_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 select-none ${className}`}
      role="img"
      aria-label="LOODY official L emblem"
    >
      <defs>
        <radialGradient id={bgId} cx="50%" cy="38%" r="72%">
          <stop offset="0%" stopColor="#0D1E17" />
          <stop offset="100%" stopColor="#050706" />
        </radialGradient>
        <linearGradient id={frontId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#34D399" />
          <stop offset="50%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#047857" />
        </linearGradient>
        <linearGradient id={depthId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#065F46" />
          <stop offset="100%" stopColor="#022C22" />
        </linearGradient>
        <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0" stdDeviation="2.2" floodColor="#34D399" floodOpacity="0.45" />
        </filter>
      </defs>

      {/* Background layer */}
      {!isTransparent && !isMonochrome && (
        <rect
          x="0"
          y="0"
          width="100"
          height="100"
          rx={isAndroid ? 24 : 18}
          fill={isFlat ? '#080C0A' : `url(#${bgId})`}
          stroke={isFlat ? '#15241D' : '#132A20'}
          strokeWidth="1.5"
        />
      )}

      {/* Geometry group (scaled slightly inside safe zone for Android adaptive icon) */}
      <g transform={isAndroid ? 'translate(10, 10) scale(0.8)' : undefined}>
        {isMonochrome ? (
          <path d={LOODY_L_PATHS.centeredFace} fill={monochromeColor} />
        ) : isFlat ? (
          <path d={LOODY_L_PATHS.centeredFace} fill="#10B981" />
        ) : (
          <g filter={variant === 'splash-3d' || variant === 'primary-3d' ? `url(#${glowId})` : undefined}>
            {/* 3D Extruded Depth Faces */}
            <path d={LOODY_L_PATHS.stemRightWall} fill={`url(#${depthId})`} />
            <path d={LOODY_L_PATHS.footTopShelf} fill="#059669" />
            <path d={LOODY_L_PATHS.footRightWall} fill={`url(#${depthId})`} />
            <path d={LOODY_L_PATHS.bottomWall} fill="#022C22" />
            {/* Metallic Emerald Front Face */}
            <path d={LOODY_L_PATHS.frontFace} fill={`url(#${frontId})`} />
            {/* Specular Neon Emerald Edge Lighting */}
            <path
              d={LOODY_L_PATHS.neonEdgeHighlight}
              stroke="#6EE7B7"
              strokeWidth="1.4"
              strokeLinejoin="miter"
              fill="none"
            />
          </g>
        )}
      </g>
    </svg>
  );
};
