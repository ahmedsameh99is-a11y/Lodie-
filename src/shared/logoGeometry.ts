/**
 * Official LOODY Logo Geometry — Concept A
 * Single source of truth for the custom three-dimensional capital letter "L".
 * All 6 official variants (Primary 3D, Flat 2D, Transparent 3D, Android App Icon,
 * Splash Screen, and Monochrome) share these exact geometric coordinates.
 */

export const LOODY_L_VIEWBOX = '0 0 100 100';

// Core architectural L silhouette (shifted slightly up-left by 3.5px when extruded to center the 3D volume)
export const LOODY_L_PATHS = {
  // Primary front face (2D & 3D front plane)
  frontFace: 'M 24 14 H 44 V 60 H 74 V 80 H 24 Z',
  // Centered 2D/monochrome face (exact same proportions, centered in 100x100)
  centeredFace: 'M 27 17 H 47 V 63 H 77 V 83 H 27 Z',
  // Extrusion depth vector (+7, +6)
  // Right wall of vertical stem
  stemRightWall: 'M 44 14 L 51 20 V 66 L 44 60 Z',
  // Top bevel wall of horizontal foot (subtle chamfered inner shelf)
  footTopShelf: 'M 44 60 L 51 66 H 81 L 74 60 Z',
  // Right end wall of horizontal foot
  footRightWall: 'M 74 60 L 81 66 V 86 L 74 80 Z',
  // Bottom underside wall of the L
  bottomWall: 'M 24 80 L 31 86 H 81 L 74 80 Z',
  // Specular neon edge highlight along upper-left & inner bevel
  neonEdgeHighlight: 'M 24 80 V 14 H 44 V 60 H 74 V 80',
} as const;

export type LoodyLogoVariant =
  | 'primary-3d'
  | 'flat-2d'
  | 'transparent-3d'
  | 'android-icon'
  | 'splash-3d'
  | 'monochrome';
