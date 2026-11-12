import TunnelBackground from "@/components/TunnelBackground";
import { useAccountSettings } from "@/lib/account-settings";
import { wallpaperStyle } from "@/lib/wallpapers";

/** The app's backdrop: the tunnel by default, or the wallpaper the signed-in account chose (every plan can change it). */
export default function Wallpaper() {
  const { wallpaper } = useAccountSettings();
  const style = wallpaperStyle(wallpaper);
  if (!style) return <TunnelBackground />;
  return <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10" style={style} />;
}
