import type { ForgeMesh } from "./forge-client";

/** Quads -> triangles, splitting along the shorter diagonal (better shading, fewer slivers). */
export function triangulate(mesh: Pick<ForgeMesh, "positions" | "quads">): Uint32Array {
  const q = mesh.quads, p = mesh.positions, n = q.length / 4, tri = new Uint32Array(n * 6);
  const d2 = (a: number, b: number) => (p[a * 3]! - p[b * 3]!) ** 2 + (p[a * 3 + 1]! - p[b * 3 + 1]!) ** 2 + (p[a * 3 + 2]! - p[b * 3 + 2]!) ** 2;
  for (let i = 0; i < n; i++) {
    const a = q[i * 4]!, b = q[i * 4 + 1]!, c = q[i * 4 + 2]!, d = q[i * 4 + 3]!;
    const o = i * 6;
    if (d2(a, c) <= d2(b, d)) { tri[o] = a; tri[o + 1] = b; tri[o + 2] = c; tri[o + 3] = a; tri[o + 4] = c; tri[o + 5] = d; }
    else { tri[o] = a; tri[o + 1] = b; tri[o + 2] = d; tri[o + 3] = b; tri[o + 4] = c; tri[o + 5] = d; }
  }
  return tri;
}

const pad4 = (n: number): number => (n + 3) & ~3;

/* ------------------------------------------------------------------ PBR material planning */

export type MaterialBin = {
  name: string; metallic: number; roughness: number; emissive: number; color: [number, number, number]; faces: number;
};

function hueBin(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (mx < 20 || d / (mx || 1) < 0.2) return 6; /* white / grey / dark */
  let h: number;
  if (mx === r) h = ((g - b) / d + 6) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  return Math.floor(h) % 6;
}

function materialName(metal: number, rough: number, emissive: number): string {
  if (emissive > 0.12) return "Emissive glow";
  if (metal > 0.7) return rough < 0.3 ? "Polished metal" : "Brushed metal";
  if (metal > 0.35) return "Satin metal";
  if (rough < 0.22) return "Gloss / glass";
  if (rough > 0.72) return "Matte";
  return "Satin";
}

/**
 * glTF has no per-vertex metallic / roughness, so regions are grouped into a handful of real PBR materials
 * (one glTF primitive each). Faces take the majority material of their four vertices.
 */
export function planMaterials(mesh: Pick<ForgeMesh, "colors" | "mats" | "quads">, maxBins = 8): { faceBin: Uint8Array; bins: MaterialBin[] } {
  const V = mesh.colors.length / 3, nQ = mesh.quads.length / 4;
  const vKey = new Uint8Array(V);
  for (let i = 0; i < V; i++) {
    const m = mesh.mats[i * 3]! / 255, r = mesh.mats[i * 3 + 1]! / 255, e = mesh.mats[i * 3 + 2]! / 127.5;
    const mq = Math.round(m * 4), rq = Math.round(r * 5);
    const eq = e < 0.12 ? 0 : 1 + hueBin(mesh.colors[i * 3]!, mesh.colors[i * 3 + 1]!, mesh.colors[i * 3 + 2]!);
    vKey[i] = (mq * 6 + rq) * 8 + eq;
  }
  const faceKey = new Uint8Array(nQ), counts = new Map<number, number>();
  for (let f = 0; f < nQ; f++) {
    const k0 = vKey[mesh.quads[f * 4]!]!, k1 = vKey[mesh.quads[f * 4 + 1]!]!, k2 = vKey[mesh.quads[f * 4 + 2]!]!, k3 = vKey[mesh.quads[f * 4 + 3]!]!;
    let best = k0, bestN = 0;
    for (const k of [k0, k1, k2, k3]) { const n = (k === k0 ? 1 : 0) + (k === k1 ? 1 : 0) + (k === k2 ? 1 : 0) + (k === k3 ? 1 : 0); if (n > bestN) { bestN = n; best = k; } }
    faceKey[f] = best;
    counts.set(best, (counts.get(best) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxBins).map(([k]) => k);
  const keyDist = (a: number, b: number) => {
    const ea = a & 7, eb = b & 7, ra = (a >> 3) % 6, rb = (b >> 3) % 6, ma = Math.floor((a >> 3) / 6), mb = Math.floor((b >> 3) / 6);
    return Math.abs(ma - mb) + 0.7 * Math.abs(ra - rb) + (ea !== eb ? 2 : 0);
  };
  const keyToBin = new Map<number, number>();
  top.forEach((k, i) => keyToBin.set(k, i));
  for (const k of counts.keys()) if (!keyToBin.has(k)) {
    let bi = 0, bd = Infinity;
    top.forEach((tk, i) => { const d = keyDist(k, tk); if (d < bd) { bd = d; bi = i; } });
    keyToBin.set(k, bi);
  }
  const sums = top.map(() => ({ m: 0, r: 0, e: 0, c: [0, 0, 0], n: 0, faces: 0 }));
  const faceBin = new Uint8Array(nQ);
  for (let f = 0; f < nQ; f++) {
    const b = keyToBin.get(faceKey[f]!) ?? 0;
    faceBin[f] = b;
    const s = sums[b]!; s.faces++;
    for (let k = 0; k < 4; k++) {
      const v = mesh.quads[f * 4 + k]!;
      s.m += mesh.mats[v * 3]! / 255; s.r += mesh.mats[v * 3 + 1]! / 255; s.e += mesh.mats[v * 3 + 2]! / 127.5;
      s.c[0]! += mesh.colors[v * 3]!; s.c[1]! += mesh.colors[v * 3 + 1]!; s.c[2]! += mesh.colors[v * 3 + 2]!; s.n++;
    }
  }
  const bins: MaterialBin[] = sums.map((s) => {
    const n = Math.max(1, s.n), metallic = s.m / n, roughness = s.r / n, emissive = s.e / n;
    return { name: materialName(metallic, roughness, emissive), metallic: Math.round(metallic * 1000) / 1000, roughness: Math.round(roughness * 1000) / 1000, emissive: Math.round(emissive * 1000) / 1000, color: [s.c[0]! / n / 255, s.c[1]! / n / 255, s.c[2]! / n / 255], faces: s.faces };
  });
  /* unique, readable names */
  const seen = new Map<string, number>();
  for (const b of bins) { const c = (seen.get(b.name) ?? 0) + 1; seen.set(b.name, c); if (c > 1) b.name = `${b.name} ${c}`; }
  return { faceBin, bins };
}

/* ------------------------------------------------------------------ GLB */

/** Binary glTF 2.0: positions, normals, vertex colours (RGBA8) and one real PBR material per surface region. */
export function meshToGlb(mesh: ForgeMesh, name = "zeros-model"): Blob {
  const V = mesh.positions.length / 3, nQ = mesh.quads.length / 4;
  const { faceBin, bins } = planMaterials(mesh);
  const rgba = new Uint8Array(V * 4);
  for (let i = 0; i < V; i++) { rgba[i * 4] = mesh.colors[i * 3]!; rgba[i * 4 + 1] = mesh.colors[i * 3 + 1]!; rgba[i * 4 + 2] = mesh.colors[i * 3 + 2]!; rgba[i * 4 + 3] = 255; }

  /* one index buffer per material, quads split on the shorter diagonal */
  const p = mesh.positions, q = mesh.quads;
  const d2 = (a: number, b: number) => (p[a * 3]! - p[b * 3]!) ** 2 + (p[a * 3 + 1]! - p[b * 3 + 1]!) ** 2 + (p[a * 3 + 2]! - p[b * 3 + 2]!) ** 2;
  const faceCounts = new Array<number>(bins.length).fill(0);
  for (let f = 0; f < nQ; f++) faceCounts[faceBin[f]!]!++;
  const wide = V > 65535, IdxArray = wide ? Uint32Array : Uint16Array;
  const idx = faceCounts.map((c) => new IdxArray(c * 6)), fill = new Array<number>(bins.length).fill(0);
  for (let f = 0; f < nQ; f++) {
    const a = q[f * 4]!, b = q[f * 4 + 1]!, c = q[f * 4 + 2]!, d = q[f * 4 + 3]!, bi = faceBin[f]!, arr = idx[bi]!, o = fill[bi]!;
    if (d2(a, c) <= d2(b, d)) { arr[o] = a; arr[o + 1] = b; arr[o + 2] = c; arr[o + 3] = a; arr[o + 4] = c; arr[o + 5] = d; }
    else { arr[o] = a; arr[o + 1] = b; arr[o + 2] = d; arr[o + 3] = b; arr[o + 4] = c; arr[o + 5] = d; }
    fill[bi]! += 6;
  }
  const used = bins.map((_, i) => i).filter((i) => faceCounts[i]! > 0);

  const chunks: { bytes: Uint8Array; target: number }[] = [
    { bytes: new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength), target: 34962 },
    { bytes: new Uint8Array(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength), target: 34962 },
    { bytes: rgba, target: 34962 },
    ...used.map((i) => ({ bytes: new Uint8Array(idx[i]!.buffer, idx[i]!.byteOffset, idx[i]!.byteLength), target: 34963 })),
  ];
  let total = 0; const offs: number[] = [];
  for (const c of chunks) { offs.push(total); total += pad4(c.bytes.byteLength); }
  const bin = new Uint8Array(total);
  chunks.forEach((c, i) => bin.set(c.bytes, offs[i]!));

  const b = mesh.stats.bounds;
  const emissiveUsed = used.some((i) => bins[i]!.emissive > 1.001);
  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "Zeros Forge v2 by VsiStudio", extras: { vertices: V, quads: nQ, pureQuad: true, watertight: mesh.stats.watertight, refineLevels: mesh.stats.refineLevels } },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: used.map((bi, k) => ({ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3 + k, material: k, mode: 4 })) }],
    materials: used.map((bi) => {
      const m = bins[bi]!;
      const mat: Record<string, unknown> = { name: m.name, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: Math.min(1, Math.max(0, m.metallic)), roughnessFactor: Math.min(1, Math.max(0.04, m.roughness)) } };
      if (m.emissive > 0.05) {
        mat["emissiveFactor"] = m.color.map((c) => Math.min(1, Math.max(0, c * Math.min(1, m.emissive))));
        if (m.emissive > 1.001) mat["extensions"] = { KHR_materials_emissive_strength: { emissiveStrength: Math.round(m.emissive * 100) / 100 } };
      }
      return mat;
    }),
    accessors: [
      { bufferView: 0, componentType: 5126, count: V, type: "VEC3", min: b.min, max: b.max },
      { bufferView: 1, componentType: 5126, count: V, type: "VEC3" },
      { bufferView: 2, componentType: 5121, normalized: true, count: V, type: "VEC4" },
      ...used.map((i, k) => ({ bufferView: 3 + k, componentType: wide ? 5125 : 5123, count: idx[i]!.length, type: "SCALAR" })),
    ],
    bufferViews: chunks.map((c, i) => ({ buffer: 0, byteOffset: offs[i]!, byteLength: c.bytes.byteLength, target: c.target })),
    buffers: [{ byteLength: total }],
  };
  if (emissiveUsed) json["extensionsUsed"] = ["KHR_materials_emissive_strength"];
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4) jsonText += " ";
  const jb = new TextEncoder().encode(jsonText);
  const out = new Uint8Array(12 + 8 + jb.length + 8 + total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  const bo = 20 + jb.length;
  dv.setUint32(bo, total, true); dv.setUint32(bo + 4, 0x004e4942, true); out.set(bin, bo + 8);
  return new Blob([out as BlobPart], { type: "model/gltf-binary" });
}

/* ------------------------------------------------------------------ OBJ / PLY / STL */

/** Wavefront OBJ with per-vertex colours and quad faces (Blender, MeshLab, Cinema 4D). Built in chunks to stay light on memory. */
export function meshToObj(mesh: ForgeMesh, name = "zeros-model"): Blob {
  const V = mesh.positions.length / 3, parts: string[] = [`# ${name} - Zeros Forge v2 by VsiStudio\no ${name}\n`];
  const CH = 40_000, P = mesh.positions, C = mesh.colors, N = mesh.normals, q = mesh.quads;
  for (let s = 0; s < V; s += CH) {
    const lines: string[] = [];
    for (let i = s; i < Math.min(V, s + CH); i++) lines.push(`v ${P[i * 3]!.toFixed(5)} ${P[i * 3 + 1]!.toFixed(5)} ${P[i * 3 + 2]!.toFixed(5)} ${(C[i * 3]! / 255).toFixed(3)} ${(C[i * 3 + 1]! / 255).toFixed(3)} ${(C[i * 3 + 2]! / 255).toFixed(3)}`);
    parts.push(lines.join("\n") + "\n");
  }
  for (let s = 0; s < V; s += CH) {
    const lines: string[] = [];
    for (let i = s; i < Math.min(V, s + CH); i++) lines.push(`vn ${N[i * 3]!.toFixed(4)} ${N[i * 3 + 1]!.toFixed(4)} ${N[i * 3 + 2]!.toFixed(4)}`);
    parts.push(lines.join("\n") + "\n");
  }
  const nQ = q.length / 4;
  for (let s = 0; s < nQ; s += CH) {
    const lines: string[] = [];
    for (let i = s; i < Math.min(nQ, s + CH); i++) {
      const a = q[i * 4]! + 1, b = q[i * 4 + 1]! + 1, c = q[i * 4 + 2]! + 1, d = q[i * 4 + 3]! + 1;
      lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c} ${d}//${d}`);
    }
    parts.push(lines.join("\n") + "\n");
  }
  return new Blob(parts, { type: "text/plain" });
}

/** Binary PLY (little-endian) with normals, vertex colours and quad faces. */
export function meshToPly(mesh: ForgeMesh, name = "zeros-model"): Blob {
  const V = mesh.positions.length / 3, nQ = mesh.quads.length / 4;
  const header = `ply\nformat binary_little_endian 1.0\ncomment ${name} - Zeros Forge v2 by VsiStudio\nelement vertex ${V}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${nQ}\nproperty list uchar int vertex_indices\nend_header\n`;
  const hb = new TextEncoder().encode(header), vStride = 27, fStride = 17;
  const out = new Uint8Array(hb.length + V * vStride + nQ * fStride), dv = new DataView(out.buffer);
  out.set(hb, 0);
  let o = hb.length;
  for (let i = 0; i < V; i++) {
    for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, mesh.positions[i * 3 + k]!, true);
    for (let k = 0; k < 3; k++) dv.setFloat32(o + 12 + k * 4, mesh.normals[i * 3 + k]!, true);
    out[o + 24] = mesh.colors[i * 3]!; out[o + 25] = mesh.colors[i * 3 + 1]!; out[o + 26] = mesh.colors[i * 3 + 2]!;
    o += vStride;
  }
  for (let f = 0; f < nQ; f++) {
    out[o] = 4;
    for (let k = 0; k < 4; k++) dv.setInt32(o + 1 + k * 4, mesh.quads[f * 4 + k]!, true);
    o += fStride;
  }
  return new Blob([out as BlobPart], { type: "application/octet-stream" });
}

/** Binary STL (a watertight mesh is directly 3D-printable). Units: 1 model unit = `scale` mm. */
export function meshToStl(mesh: ForgeMesh, scale = 50): Blob {
  const tri = triangulate(mesh), n = tri.length / 3;
  if (n > 3_500_000) throw new Error("This mesh is too dense for STL. Export GLB, OBJ or PLY instead.");
  const out = new Uint8Array(84 + n * 50), dv = new DataView(out.buffer), p = mesh.positions;
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = tri[t * 3]!, b = tri[t * 3 + 1]!, c = tri[t * 3 + 2]!;
    const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!, wx = p[c * 3]! - p[a * 3]!, wy = p[c * 3 + 1]! - p[a * 3 + 1]!, wz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true); o += 12;
    for (const v of [a, b, c]) { dv.setFloat32(o, p[v * 3]! * scale, true); dv.setFloat32(o + 4, p[v * 3 + 1]! * scale, true); dv.setFloat32(o + 8, p[v * 3 + 2]! * scale, true); o += 12; }
    o += 2;
  }
  return new Blob([out as BlobPart], { type: "model/stl" });
}
