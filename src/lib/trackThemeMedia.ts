import { isObjectStorageConfigError, objectUrl } from "./objectStorage.js";

export const TRACK_THEME_CODES = [
  "bg",
  "daylightStadium",
  "bg1",
  "galaxy",
  "forest",
  "city",
  "lava",
  "ice",
  "candy",
  "farm",
  "underwater",
  "musicfest",
  "barbie",
  "desert",
  "gold",
  "nightforest",
  "skykingdom",
  "rain",
  "storm",
  "mountain",
  "waterfall",
  "webcity",
  "bridge",
  "newyork",
  "pirateisland",
  "paradise",
  "musicfest2",
  "chocolate",
  "fireworks",
  "moon",
  "rainbow_road",
  "runway",
  "toy_race",
  "water_park",
] as const;

export type TrackThemeCode = typeof TRACK_THEME_CODES[number];
export type TrackThemeImageVariant = "thumb" | "preview" | "full";

export type TrackThemeImageSet = {
  thumb: string;
  preview: string;
  full: string;
};

export type TrackThemeMedia = {
  code: string;
  assetVersion: number;
  width: number;
  height: number;
  imageSet: TrackThemeImageSet | null;
  imageUrl: string;
};

export const TRACK_THEME_DEFAULT_WIDTH = 1080;
export const TRACK_THEME_DEFAULT_HEIGHT = 1920;
export const TRACK_THEME_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export const TRACK_THEME_VARIANTS: Record<TrackThemeImageVariant, {
  maxBytes: number;
  quality: number;
  width: number;
  height?: number;
}> = {
  thumb: { width: 320, quality: 60, maxBytes: 120 * 1024 },
  preview: { width: 768, quality: 70, maxBytes: 350 * 1024 },
  full: { width: 1080, height: 1920, quality: 78, maxBytes: 900 * 1024 },
};

export function normalizeTrackThemeAssetVersion(assetVersion: number | null | undefined): number {
  if (!Number.isFinite(assetVersion) || !assetVersion || assetVersion < 1) return 1;
  return Math.trunc(assetVersion);
}

export function trackThemeObjectKey(code: string, variant: TrackThemeImageVariant, assetVersion: number): string {
  const version = normalizeTrackThemeAssetVersion(assetVersion);
  return `race-themes/${code}/${variant}.v${version}.webp`;
}

export function legacyTrackThemeImageUrl(code: string): string {
  return `/api/track-themes/${encodeURIComponent(code)}/image`;
}

export function buildTrackThemeImageSet(code: string, assetVersion: number): TrackThemeImageSet | null {
  try {
    return {
      thumb: objectUrl(trackThemeObjectKey(code, "thumb", assetVersion)),
      preview: objectUrl(trackThemeObjectKey(code, "preview", assetVersion)),
      full: objectUrl(trackThemeObjectKey(code, "full", assetVersion)),
    };
  } catch (err) {
    if (isObjectStorageConfigError(err)) return null;
    throw err;
  }
}

export function buildTrackThemeMedia(
  code: string | null | undefined,
  assetVersion: number | null | undefined = 1,
): TrackThemeMedia {
  const normalizedCode = code?.trim() || "bg";
  const version = normalizeTrackThemeAssetVersion(assetVersion);
  const imageSet = buildTrackThemeImageSet(normalizedCode, version);
  return {
    code: normalizedCode,
    assetVersion: version,
    width: TRACK_THEME_DEFAULT_WIDTH,
    height: TRACK_THEME_DEFAULT_HEIGHT,
    imageSet,
    imageUrl: imageSet?.preview ?? legacyTrackThemeImageUrl(normalizedCode),
  };
}
