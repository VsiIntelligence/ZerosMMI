import type { CSSProperties } from "react";

/** A slow, luminous glass sphere used on the plan and sign-in sheets. (The home screen keeps its own original orb.) */
export default function LuminousOrb({ size = 40 }: { size?: number }) {
  const style = { width: size, height: size, "--orb": `${size}px` } as CSSProperties;
  return <span className="zx-orb" style={style} aria-hidden="true"><i /></span>;
}
