import { useState, type CSSProperties } from "react";
import { Check, ImageIcon, XCircle } from "lucide-react";
import { updateSettings, useAccountSettings } from "@/lib/account-settings";
import { MAX_CUSTOM_BYTES, WALLPAPERS, isSafeImageDataUrl, wallpaperStyle, type WallpaperId } from "@/lib/wallpapers";

const TUNNEL_PREVIEW = "radial-gradient(circle at 50% 50%, #000 0 9%, #1a1030 10% 22%, #000 23% 34%, #241440 35% 48%, #07040f 49% 100%)";

export default function AppearancePanel() {
  const { wallpaper: current } = useAccountSettings();
  const [error, setError] = useState<string | null>(null);

  const choose = (id: Exclude<WallpaperId, "custom">) => { updateSettings({ wallpaper: { id } }); setError(null); };
  const upload = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { setError("Use a PNG, JPEG, WebP or GIF image."); return; }
    if (file.size > MAX_CUSTOM_BYTES) { setError("That image is larger than 2.5 MB. Choose a smaller one."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!isSafeImageDataUrl(dataUrl)) { setError("That file could not be used as a wallpaper."); return; }
      updateSettings({ wallpaper: { id: "custom", dataUrl } });
    };
    reader.onerror = () => setError("The image could not be read.");
    reader.readAsDataURL(file);
  };

  const customStyle = current.id === "custom" ? wallpaperStyle(current) : null;
  return (
    <div>
      <h2 className="zx-h2">Appearance</h2>
      <p className="zx-lede">Choose the backdrop behind your chats. It is saved to your account and follows you to every device.</p>
      <div className="zx-section">
        <div className="zx-wallgrid" role="group" aria-label="Wallpaper">
          {WALLPAPERS.map((w) => {
            const art: CSSProperties = w.id === "tunnel" ? { background: TUNNEL_PREVIEW } : (wallpaperStyle({ id: w.id }) as CSSProperties | null) ?? {};
            const on = current.id === w.id;
            return (
              <button key={w.id} type="button" className="zx-wall-tile" aria-pressed={on} onClick={() => choose(w.id)}>
                <span className="zx-wall-tile__art" style={art}>{on ? <span className="zx-wall-tile__check"><Check aria-hidden="true" /></span> : null}</span>
                {w.label.replace(" (default)", "")}
              </button>
            );
          })}
          {customStyle ? (
            <button type="button" className="zx-wall-tile" aria-pressed="true" onClick={() => undefined}>
              <span className="zx-wall-tile__art" style={customStyle as CSSProperties}><span className="zx-wall-tile__check"><Check aria-hidden="true" /></span></span>
              Your image
            </button>
          ) : null}
        </div>
        <label className="zx-upload">
          <ImageIcon aria-hidden="true" /> Upload your own image (up to 2.5 MB)
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { upload(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
        </label>
        {error ? <div role="alert" className="zx-notice zx-notice--error" style={{ marginTop: "0.75rem" }}><XCircle aria-hidden="true" /><div>{error}</div></div> : null}
      </div>
    </div>
  );
}
