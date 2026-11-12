import { useEffect, useState } from "react";
import type { ZeroMode } from "@/lib/zeros";

type Props = {
  mode?: ZeroMode | undefined;
  status?: string | null | undefined;
  /** Only true while a response is being generated. Never show when idle. */
  active?: boolean | undefined;
};

/** Zeros keeps you company while it works: these rotate whenever the pipeline has no more specific status to show. */
const WAITING: Record<string, string[]> = {
  chat: ["Consulting my three brain cells and one very large espresso…", "Rehearsing the punchline so it actually lands…", "Reading between the lines (and the lines between those)…", "Doing the thinking so you can do the laughing…"],
  search: ["Interrogating the internet, politely…", "Cross-checking sources like a suspicious detective…", "Separating facts from vibes…"],
  image: ["Mixing pixels in the good bowl…", "Persuading the light to behave…", "Arguing with the colour wheel (I'm winning)…"],
  model: ["Herding millions of particles into formation…", "Teaching maths to hold a pose…", "Sanding the topology until it squeaks…"],
  music: ["Tuning a choir of very tiny oscillators…", "Rhyming 'moon' with something that is not 'soon'…", "Bribing the drummer with extra reverb…"],
  web: ["Arguing with the grid system…", "Making the buttons feel expensive…"],
  video: ["Convincing frames to arrive in order…", "Directing pixels through a tiny megaphone…"],
};
const GENERIC = /^(thinking|sculpting|composing|understanding|loading chat|preparing)/i;

/**
 * Thinking indicator: spinning orb + THINKING + cyan dots + live status.
 * Inline styles so it stays visible over the tunnel background.
 */
export default function ThinkingTrace({ active = false, status, mode }: Props) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 3600);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active) return null;
  const lines = WAITING[mode ?? "chat"] ?? WAITING["chat"]!;
  const shown = !status || GENERIC.test(status) ? lines[tick % lines.length] : status;

  return (
    <div
      className="zeros-thinking flex items-center gap-2"
      role="status"
      aria-live="polite"
      aria-label={shown || "Thinking"}
      style={{ color: "#f4f7ff" }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "radial-gradient(circle at 30% 30%, #7ef9d8, #22d3ee 45%, #6366f1 100%)",
          boxShadow: "0 0 12px rgba(34,211,238,0.7)",
          animation: "zeros-spin 1.1s linear infinite",
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          background: "linear-gradient(90deg,#e0e7ff,#67e8f9,#c4b5fd)",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        Thinking
      </span>
      <span aria-hidden="true" className="flex items-center gap-1" style={{ marginLeft: 2 }}>
        {[0, 1, 2].map((i) => (
          <i
            key={i}
            style={{
              display: "inline-block",
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "#67e8f9",
              opacity: 0.35,
              animation: `zeros-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </span>
      {shown ? (
        <span style={{ color: "#a8e8d8", marginLeft: 6, fontSize: 12, fontWeight: 500 }}>
          {shown}
        </span>
      ) : null}
      <style>{`
        @keyframes zeros-spin { to { transform: rotate(360deg); } }
        @keyframes zeros-dot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
          40% { opacity: 1; transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
