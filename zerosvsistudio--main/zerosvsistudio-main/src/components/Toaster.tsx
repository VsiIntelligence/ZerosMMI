import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { dismissToast, useToasts } from "@/lib/toast";

const ICON = { success: CheckCircle2, error: XCircle, info: Info } as const;

/** Where notifications appear. Mounted once on the chat page. */
export default function Toaster() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="zx-toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICON[t.tone];
        return (
          <div key={t.id} className={`zx-toast zx-toast--${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            <Icon aria-hidden="true" />
            <div className="zx-toast__text">
              <div className="zx-toast__title">{t.title}</div>
              {t.text ? <div className="zx-toast__body">{t.text}</div> : null}
            </div>
            <button type="button" className="zx-icon-btn zx-icon-btn--sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><X /></button>
          </div>
        );
      })}
    </div>
  );
}
