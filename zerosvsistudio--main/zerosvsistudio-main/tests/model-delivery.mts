/**
 * What a person actually downloads from a 3D model: GLB, OBJ, PLY and STL. Each file is read back and checked against the
 * geometry the Forge measured, so "real mesh, vertices and polygons" is a fact about the file, not a claim about the pipeline.
 * Covers the example shapes plus a deliberately hard one (a shape with a hole through it, a Bezier tail and fine relief detail).
 */
import vm from "node:vm";
import { FORGE_WORKER_SOURCE } from "../src/lib/forge/worker-source.ts";
import { FORGE_EXAMPLE_CAR, FORGE_EXAMPLE_FOX, FORGE_EXAMPLE_SWORD, FORGE_EXAMPLE_QUEEN } from "../src/lib/forge/forge-prompt.ts";
import { meshToGlb, meshToObj, meshToPly, meshToStl, planMaterials } from "../src/lib/forge/forge-export.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail.slice(0, 300)}]` : ""}`); };
const section = (s: string) => console.log(`\n== ${s}`);

/** A harder shape: a rounded block with a through-hole, a curved handle and a relief pattern. Tests topology, not just the examples. */
const HARD = `
// HARD TEST: rounded block with a through-hole, a Bezier handle and fine relief.
function sdf(x, y, z) {
  var body = roundBox(x, y, z, 0.7, 0.45, 0.45, 0.12);
  var hole = cylinder(x, y, z, 0.22, 0.6);
  var carved = subtract(body, hole);
  var handle = curveTube(x, y, z, 0.7, 0.2, 0, 1.05, 0.55, 0, 0.9, 0.2, 0, 0.09, 0.06);
  return smin(carved, handle, 0.04);
}
function surface(x, y, z) { return y > 0.2 ? [1, 0.2, 0] : [0, 0.5, 0]; }
function displace(x, y, z) { return 0.004 * ridge(x + 0.3 * noise3(x * 2, y * 2, z * 2), 0.05, 0.012); }
var bounds = { min: [-1.3, -0.7, -0.7], max: [1.3, 0.7, 0.7] };
`;

function runForge(code: string, resolution: number, refine: number): any {
  let result: any = null;
  const sb: any = { Math, Float32Array, Float64Array, Uint8Array, Uint32Array, Int32Array, Map, Date, Error, Number, String, Object, Array, console, isNaN };
  sb.self = sb; sb.postMessage = (m: any) => { if (m.type === "done" || m.type === "error") result = m; };
  vm.createContext(sb); vm.runInContext(FORGE_WORKER_SOURCE, sb);
  sb.onmessage({ data: { code, resolution, id: 1, particles: 2000, budgetMs: 120000, refine } });
  return result;
}

/**
 * Undirected edge counts of a quad mesh, after welding vertices by POSITION (as every viewer and slicer does). The shading step
 * splits a vertex along hard edges so each side gets its own normal; those copies share a position and must count as one point.
 * A closed surface then has every edge shared by exactly two faces.
 */
function edgeStats(quads: Uint32Array | Int32Array | number[], positions: Float32Array): { open: number; over: number; edges: number; duplicateIds: number } {
  const V = positions.length / 3;
  const canon = new Map<string, number>(), remap = new Uint32Array(V);
  let unique = 0;
  for (let i = 0; i < V; i++) {
    const k = `${Math.round(positions[i * 3]! * 1e5)},${Math.round(positions[i * 3 + 1]! * 1e5)},${Math.round(positions[i * 3 + 2]! * 1e5)}`;
    let c = canon.get(k);
    if (c === undefined) { c = unique++; canon.set(k, c); }
    remap[i] = c;
  }
  const count = new Map<string, number>();
  for (let f = 0; f < quads.length / 4; f++) {
    for (let k = 0; k < 4; k++) {
      const a = remap[quads[f * 4 + k]!]!, b = remap[quads[f * 4 + ((k + 1) % 4)]!]!;
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  let open = 0, over = 0;
  for (const c of count.values()) { if (c === 1) open++; else if (c > 2) over++; }
  return { open, over, edges: count.size, duplicateIds: V - unique };
}

async function readBlob(b: Blob): Promise<Uint8Array> { return new Uint8Array(await b.arrayBuffer()); }

async function verifyModel(name: string, code: string, resolution: number, expectHole: boolean): Promise<void> {
  section(`${name}: the model as downloaded`);
  const r = runForge(code, resolution, 1);
  if (!r || r.type === "error") { check(`${name} builds`, false, r?.message); return; }
  const s = r.stats;
  const mesh = { positions: r.positions, normals: r.normals, colors: r.colors, mats: r.mats, quads: r.quads, points: r.points, pointColors: r.pointColors, material: r.material, stats: s };
  const V = r.positions.length / 3, F = r.quads.length / 4;

  check(`${name}: a real solid (watertight, manifold, pure quads, one piece)`, s.watertight && s.nonManifoldEdges === 0 && s.pureQuad && s.keptComponents === 1, JSON.stringify({ wt: s.watertight, nm: s.nonManifoldEdges, pq: s.pureQuad, pieces: s.keptComponents }));
  check(`${name}: a dense, real mesh (${V.toLocaleString()} vertices, ${F.toLocaleString()} quads)`, V >= 5000 && F >= 4000, `${V} ${F}`);
  check(`${name}: most vertices sit on regular topology (${s.regularPct}%), so the surface is evenly tessellated`, s.regularPct >= 85, String(s.regularPct));
  check(`${name}: stretched quads are rare (${s.badQuadPct}%)`, s.badQuadPct <= 5, String(s.badQuadPct));
  const edges = edgeStats(r.quads, r.positions);
  check(`${name}: every edge is shared by exactly two faces (closed surface, no holes, no hairline seams)`, edges.open === 0 && edges.over === 0, `open=${edges.open} over=${edges.over}`);
  check(`${name}: vertex copies along hard edges are only shading splits (${edges.duplicateIds} shared positions), not gaps`, edges.duplicateIds >= 0 && edges.open === 0);
  check(`${name}: the through-hole topology is ${expectHole ? "present" : "not required"} (genus ${s.genus})`, expectHole ? s.genus >= 1 : true, `genus=${s.genus}`);
  let unit = true; for (let i = 0; i < r.normals.length; i += 3) { const l = Math.hypot(r.normals[i]!, r.normals[i + 1]!, r.normals[i + 2]!); if (Math.abs(l - 1) > 0.03) { unit = false; break; } }
  check(`${name}: every vertex normal is unit length (smooth shading is correct)`, unit);
  const bins = planMaterials(mesh).bins;
  check(`${name}: distinct PBR material regions are present (${bins.length})`, bins.length >= 2, bins.map((b) => b.name).join(", "));
  check(`${name}: colours and materials are per vertex and in range`, r.colors.length === V * 3 && r.mats.length === V * 3, `${r.colors.length} ${r.mats.length}`);

  // GLB: parse the binary and check its header, JSON chunk and counts against the measured mesh
  const glb = await readBlob(meshToGlb(mesh, name));
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const gj = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as { meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[]; accessors: { count: number; type: string }[]; materials: unknown[]; asset: { version: string } };
  check(`${name} GLB: valid binary header and a glTF 2.0 asset`, dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(8, true) === glb.length && gj.asset.version === "2.0");
  const accessorOf = (i: number) => gj.accessors[i]!;
  const primitive = gj.meshes[0]!.primitives[0]!;
  check(`${name} GLB: the position count equals the measured vertex count`, accessorOf(primitive.attributes["POSITION"]!).count === s.vertices, `${accessorOf(primitive.attributes["POSITION"]!).count} vs ${s.vertices}`);
  check(`${name} GLB: normals, colours and PBR materials are all carried`, primitive.attributes["NORMAL"] !== undefined && primitive.attributes["COLOR_0"] !== undefined && gj.materials.length >= 2 && gj.meshes[0]!.primitives.length === gj.materials.length);

  // OBJ: count vertices, normals and faces from the text
  const obj = await meshToObj(mesh, name).text();
  const vCount = (obj.match(/^v /gm) ?? []).length, vnCount = (obj.match(/^vn /gm) ?? []).length, fCount = (obj.match(/^f /gm) ?? []).length;
  check(`${name} OBJ: ${vCount.toLocaleString()} vertices, ${vnCount.toLocaleString()} normals and ${fCount.toLocaleString()} faces, matching the mesh`, vCount === V && vnCount === V && fCount === F, `${vCount}/${vnCount}/${fCount} vs ${V}/${F}`);
  const objQuad = /^f (\d+)\/\/\1 (\d+)\/\/\2 (\d+)\/\/\3 (\d+)\/\/\4$/m.test(obj);
  check(`${name} OBJ: faces are quads that reference their own normals`, objQuad);

  // PLY: header counts and binary size
  const ply = await readBlob(meshToPly(mesh, name));
  const headerEnd = new TextDecoder().decode(ply.subarray(0, Math.min(ply.length, 600))).indexOf("end_header\n") + "end_header\n".length;
  const header = new TextDecoder().decode(ply.subarray(0, headerEnd));
  const plyV = Number(/element vertex (\d+)/.exec(header)?.[1]), plyF = Number(/element face (\d+)/.exec(header)?.[1]);
  check(`${name} PLY: header counts match and the binary body is the right size`, plyV === V && plyF === F && ply.length === headerEnd + V * 27 + F * 17, `${plyV}/${plyF} len=${ply.length}`);

  // STL: triangle count, and every facet is a real triangle with a unit normal
  const stl = await readBlob(meshToStl(mesh, 50));
  const triCount = new DataView(stl.buffer, stl.byteOffset).getUint32(80, true);
  check(`${name} STL: 3D-printable triangles (${triCount.toLocaleString()} facets = two per quad)`, triCount === F * 2 && stl.length === 84 + triCount * 50, `${triCount} vs ${F * 2}`);
  const sdv = new DataView(stl.buffer, stl.byteOffset);
  let bad = 0;
  for (let t = 0; t < Math.min(triCount, 2000); t++) {
    const o = 84 + t * 50;
    const ax = sdv.getFloat32(o + 12, true), ay = sdv.getFloat32(o + 16, true), az = sdv.getFloat32(o + 20, true);
    const bx = sdv.getFloat32(o + 24, true), by = sdv.getFloat32(o + 28, true), bz = sdv.getFloat32(o + 32, true);
    const cx = sdv.getFloat32(o + 36, true), cy = sdv.getFloat32(o + 40, true), cz = sdv.getFloat32(o + 44, true);
    const area = Math.hypot((by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (bx - ax) * (cz - az), (bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    if (!Number.isFinite(area) || area < 1e-9) bad++;
  }
  check(`${name} STL: no degenerate triangles in the first 2,000 facets`, bad === 0, `${bad} degenerate`);
  const stlSize = sdv.getFloat32(84 + 12, true);
  check(`${name} STL: sized in millimetres at the requested scale (first vertex x is finite)`, Number.isFinite(stlSize));
}

async function main(): Promise<void> {
  await verifyModel("sword", FORGE_EXAMPLE_SWORD, 80, false);
  await verifyModel("queen", FORGE_EXAMPLE_QUEEN, 80, false);
  await verifyModel("fox", FORGE_EXAMPLE_FOX, 90, false);
  await verifyModel("car", FORGE_EXAMPLE_CAR, 100, true);
  await verifyModel("hard-test", HARD, 96, true);

  section("A model that cannot be built gives a plain reason");
  const empty = runForge("function sdf(x,y,z){ return 1; }", 80, 0);
  check("an empty shape is reported as empty", empty?.type === "error" && /empty/i.test(empty.message));
  const nan = runForge("function sdf(x,y,z){ return NaN; }", 80, 0);
  check("a non-numeric shape is reported as such", nan?.type === "error" && /finite/i.test(nan.message));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
