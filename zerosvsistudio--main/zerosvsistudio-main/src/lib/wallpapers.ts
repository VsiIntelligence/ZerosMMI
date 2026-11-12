/** Wallpapers: the default tunnel, a set of cinematic presets, or the person's own image. The choice is saved with the account (see account-settings). */
export type WallpaperId = "tunnel" | "aurora" | "midnight" | "ember" | "mint" | "paper" | "custom";
export type WallpaperChoice = { id: WallpaperId; dataUrl?: string };

export const WALLPAPERS: { id: Exclude<WallpaperId, "custom">; label: string; css: string }[] = [
  { id: "tunnel", label: "Tunnel (default)", css: "" },
  { id: "aurora", label: "Aurora", css: "radial-gradient(60% 50% at 20% 20%, rgba(108,140,255,.55), transparent 70%), radial-gradient(55% 45% at 80% 30%, rgba(255,122,217,.45), transparent 70%), linear-gradient(160deg,#0b0f1f,#050611)" },
  { id: "midnight", label: "Midnight", css: "radial-gradient(70% 60% at 50% 0%, rgba(60,80,160,.45), transparent 70%), linear-gradient(180deg,#070a14,#02030a)" },
  { id: "ember", label: "Ember", css: "radial-gradient(60% 50% at 80% 80%, rgba(255,120,60,.45), transparent 70%), linear-gradient(170deg,#1a0c08,#070303)" },
  { id: "mint", label: "Mint", css: "radial-gradient(60% 50% at 20% 80%, rgba(52,224,161,.35), transparent 70%), linear-gradient(170deg,#06130f,#020807)" },
  { id: "paper", label: "Paper", css: "radial-gradient(70% 60% at 50% 0%, #ffffff, #f3efe8)" },
];

export const MAX_CUSTOM_BYTES = 2_500_000;

/** Only real raster images in base64 are accepted: nothing that could carry script or break the CSS it is placed in. */
export function isSafeImageDataUrl(url: string): boolean {
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url) && url.length <= Math.ceil(MAX_CUSTOM_BYTES * 1.37);
}

/** The CSS that paints a non-tunnel wallpaper, or null when the tunnel itself should be shown. */
export function wallpaperCss(choice: WallpaperChoice): string | null {
  if (choice.id === "tunnel") return null;
  if (choice.id === "custom") return choice.dataUrl ? `background-image:url("${choice.dataUrl}");background-size:cover;background-position:center;` : null;
  const preset = WALLPAPERS.find((w) => w.id === choice.id);
  return preset ? `background:${preset.css};` : null;
}

/** The inline style that paints a non-tunnel wallpaper (kept as an object so no CSS text is ever parsed). */
export function wallpaperStyle(choice: WallpaperChoice): Record<string, string> | null {
  if (choice.id === "tunnel") return null;
  if (choice.id === "custom") return choice.dataUrl && isSafeImageDataUrl(choice.dataUrl) ? { backgroundImage: `url("${choice.dataUrl}")`, backgroundSize: "cover", backgroundPosition: "center" } : null;
  const preset = WALLPAPERS.find((w) => w.id === choice.id);
  return preset ? { background: preset.css } : null;
}
