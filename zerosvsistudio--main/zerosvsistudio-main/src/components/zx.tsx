/** Shared building blocks of the Zeros interface: the sheet (every dialog), the switch, an app's logo and the spinner. */
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** True once the page is running in the browser, so portals never render on the server. */
export function usePortalReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/** Open sheets, topmost last: Escape and Tab only act on the one on top. */
const stack: symbol[] = [];

/** Focus, Escape, Tab and scroll-lock behaviour shared by every overlay. Only the topmost overlay reacts. */
function useModal(onClose: () => void) {
  const ready = usePortalReady();
  const panel = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!ready) return undefined;
    const node = panel.current;
    const token = Symbol("overlay");
    stack.push(token);
    const previous = document.activeElement as HTMLElement | null;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return;
      if (e.key === "Escape") { e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab" || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0]!, last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === node)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(token), 1);
      document.body.style.overflow = overflow;
      previous?.focus?.({ preventScroll: true });
    };
  }, [ready]);

  return { ready, panel, close };
}

export function Sheet({ label, onClose, size = "md", centered = false, className = "", children }: {
  label: string;
  onClose: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  centered?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { ready, panel, close } = useModal(onClose);
  if (!ready) return null;
  return createPortal(
    <div className={`zx-overlay${centered ? " zx-overlay--center" : ""}`} onMouseDown={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) close.current(); }}>
      <div ref={panel as RefObject<HTMLDivElement>} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={`zx-sheet zx-sheet--${size}${className ? ` ${className}` : ""}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Switch({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="zx-switch" onClick={() => onChange(!checked)} />;
}

/**
 * An app's logo on a light tile, so dark and coloured marks both read. It shows the logo Composio serves for the app; if that
 * picture cannot be loaded, the app's official brand mark from the built-in library; and only then its first letter.
 */
export function AppLogo({ src, name, slug, size }: { src?: string | null; name: string; slug?: string; size?: number }) {
  const [stage, setStage] = useState<"remote" | "mark" | "initial">(src ? "remote" : "mark");
  const [mark, setMark] = useState<{ d: string; color: string } | null>(null);
  useEffect(() => { setStage(src ? "remote" : "mark"); setMark(null); }, [src, slug]);
  useEffect(() => {
    if (stage !== "mark") return undefined;
    if (!slug) { setStage("initial"); return undefined; }
    let live = true;
    // The library is only fetched when a picture actually failed to load.
    void import("@/lib/app-marks").then((lib) => {
      if (!live) return;
      const found = lib.markFor(slug);
      if (found) setMark(found); else setStage("initial");
    });
    return () => { live = false; };
  }, [stage, slug]);
  const style = size ? { width: size, height: size } : undefined;
  return (
    <span className="zx-logo" aria-hidden="true" {...(style ? { style } : {})}>
      {stage === "remote" && src
        ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setStage("mark")} />
        : stage === "mark" && mark
          ? <svg viewBox="0 0 24 24" focusable="false"><path d={mark.d} fill={mark.color} /></svg>
          : stage === "initial" ? <span className="zx-logo__initial">{name.trim().charAt(0).toUpperCase() || "?"}</span> : null}
    </span>
  );
}

export function Spinner() {
  return <span className="zx-spinner" aria-hidden="true" />;
}
