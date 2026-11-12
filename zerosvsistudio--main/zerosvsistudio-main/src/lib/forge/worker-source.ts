/**
 * Zeros Particle Forge v2 - worker program (String.raw: NO backticks and NO dollar-brace sequences inside).
 *
 * The model writes `function sdf(x,y,z)` plus optional `color`, `surface`, `displace`, `material`, `bounds`.
 * The worker then:
 *   1. compiles the program in a sandbox (network / storage / nested workers removed)
 *   2. probes the shape and fills a SPARSE signed-distance grid (far blocks are skipped)
 *   3. fuses it into ONE welded all-quad surface with Surface Nets
 *   4. removes floating debris and degenerate quads
 *   5. snaps every vertex onto the exact surface and RELOCATES it with a feature-preserving QEF pass,
 *      so hard edges stay crisp instead of being rounded off by the voxel grid
 *   6. optionally REFINES the mesh (each quad -> 4 quads, new vertices projected onto the exact surface),
 *      which quadruples detail while keeping a pure-quad, evenly-spaced topology
 *   7. applies optional micro-displacement, rebuilds crease-aware normals (auto-smooth with split vertices)
 *   8. samples colour + PBR (metallic / roughness / emissive) per vertex
 *   9. scatters a particle cloud over the finished skin and measures topology quality
 *
 * Messages in : { code, resolution, id, particles, budgetMs, refine, maxCells, vertexBudget, mobile }
 * Messages out: { type: "progress" | "done" | "error", ... }  (typed arrays are transferred)
 */
export const FORGE_WORKER_SOURCE = String.raw`
"use strict";
/* The shape program is model-written code: cut it off from the network, storage and nested workers before it runs. */
["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker", "WebTransport"].forEach(function (k) {
  try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch (e) { try { self[k] = undefined; } catch (e2) {} }
});

/* ================================================================== toolkit */
var PI = Math.PI, TAU = Math.PI * 2;
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function mix(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a || 1e-9), 0, 1); return t * t * (3 - 2 * t); }
function fract(x) { return x - Math.floor(x); }
function sphere(x, y, z, r) { return Math.sqrt(x * x + y * y + z * z) - r; }
function box(x, y, z, hx, hy, hz) {
  var qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
  var ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
}
function roundBox(x, y, z, hx, hy, hz, r) { return box(x, y, z, hx - r, hy - r, hz - r) - r; }
function cylinder(x, y, z, r, h) { var dx = Math.sqrt(x * x + z * z) - r, dy = Math.abs(y) - h; var ax = dx > 0 ? dx : 0, ay = dy > 0 ? dy : 0; return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ax * ax + ay * ay); }
function roundCylinder(x, y, z, r, h, k) { return cylinder(x, y, z, r - k, h - k) - k; }
function capsule(x, y, z, ax, ay, az, bx, by, bz, r) {
  var px = x - ax, py = y - ay, pz = z - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  var h = (px * bax + py * bay + pz * baz) / (bax * bax + bay * bay + baz * baz + 1e-9); h = h < 0 ? 0 : h > 1 ? 1 : h;
  var dx = px - bax * h, dy = py - bay * h, dz = pz - baz * h; return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}
function taperedCapsule(x, y, z, ax, ay, az, ra, bx, by, bz, rb) {
  var px = x - ax, py = y - ay, pz = z - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  var h = (px * bax + py * bay + pz * baz) / (bax * bax + bay * bay + baz * baz + 1e-9); h = h < 0 ? 0 : h > 1 ? 1 : h;
  var dx = px - bax * h, dy = py - bay * h, dz = pz - baz * h; return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
}
function torus(x, y, z, R, r) { var q = Math.sqrt(x * x + z * z) - R; return Math.sqrt(q * q + y * y) - r; }
function cone(x, y, z, r, h) { /* apex up (+y), base radius r at y=-h, apex at y=+h */
  var q = Math.sqrt(x * x + z * z), k = r / (2 * h), s = (h - y) * k;
  var d1 = q - s * 1.0; var d2 = Math.abs(y) - h; return Math.max(d1 * 0.894, d2);
}
function cappedCone(x, y, z, h, r1, r2) { /* axis y: radius r1 at y=-h, radius r2 at y=+h (exact) */
  var qx = Math.sqrt(x * x + z * z), qy = y;
  var k1x = r2, k1y = h, k2x = r2 - r1, k2y = 2 * h;
  var cax = qx - Math.min(qx, qy < 0 ? r1 : r2), cay = Math.abs(qy) - h;
  var t = clamp(((k1x - qx) * k2x + (k1y - qy) * k2y) / (k2x * k2x + k2y * k2y + 1e-12), 0, 1);
  var cbx = qx - k1x + k2x * t, cby = qy - k1y + k2y * t;
  var s = (cbx < 0 && cay < 0) ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}
function roundCone(x, y, z, r1, r2, h) { /* sphere r1 at origin, sphere r2 at (0,h,0), smooth hull */
  var b = clamp((r1 - r2) / h, -0.999, 0.999), a = Math.sqrt(1 - b * b);
  var qx = Math.sqrt(x * x + z * z), qy = y, k = qx * (-b) + qy * a;
  if (k < 0) return Math.sqrt(qx * qx + qy * qy) - r1;
  if (k > a * h) return Math.sqrt(qx * qx + (qy - h) * (qy - h)) - r2;
  return qx * a + qy * b - r1;
}
function hexPrism(x, y, z, r, hh) { /* hexagon (circumradius ~ r) in the x-z plane, half height hh along y */
  var kx = -0.8660254, ky = 0.5, kz = 0.57735;
  var px = Math.abs(x), pz = Math.abs(z), py = Math.abs(y);
  var m = 2 * Math.min(kx * px + ky * pz, 0); px -= m * kx; pz -= m * ky;
  var cx = clamp(px, -kz * r, kz * r);
  var dx = Math.sqrt((px - cx) * (px - cx) + (pz - r) * (pz - r)) * (pz - r >= 0 ? 1 : -1), dy = py - hh;
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(Math.max(dx, 0) * Math.max(dx, 0) + Math.max(dy, 0) * Math.max(dy, 0));
}
function octahedron(x, y, z, s) { return (Math.abs(x) + Math.abs(y) + Math.abs(z) - s) * 0.57735027; }
function pyramid(x, y, z, w, h) { /* square base of half-width w at y=0, apex at y=h */
  var hh = h / w, px = Math.abs(x / w), py = y / w, pz = Math.abs(z / w);
  if (pz > px) { var tt = px; px = pz; pz = tt; }
  px -= 0.5; pz -= 0.5;
  var m2 = hh * hh + 0.25;
  var qx = pz, qy = hh * py - 0.5 * px, qz = hh * px + 0.5 * py;
  var s = Math.max(-qx, 0), t = clamp((qy - 0.5 * pz) / (m2 + 0.25), 0, 1);
  var a = m2 * (qx + s) * (qx + s) + qy * qy, b = m2 * (qx + 0.5 * t) * (qx + 0.5 * t) + (qy - m2 * t) * (qy - m2 * t);
  var d2 = Math.min(qy, -qx * m2 - qy * 0.5) > 0 ? 0 : Math.min(a, b);
  var sg = Math.max(qz, -py) >= 0 ? 1 : -1;
  return Math.sqrt((d2 + qz * qz) / m2) * sg * w;
}
function ellipsoid(x, y, z, rx, ry, rz) {
  var k0 = Math.sqrt((x / rx) * (x / rx) + (y / ry) * (y / ry) + (z / rz) * (z / rz));
  var k1 = Math.sqrt((x / (rx * rx)) * (x / (rx * rx)) + (y / (ry * ry)) * (y / (ry * ry)) + (z / (rz * rz)) * (z / (rz * rz)));
  return k1 < 1e-9 ? -Math.min(rx, ry, rz) : k0 * (k0 - 1) / k1;
}
/* quadratic Bezier tube (A -> B -> C) with radius r0 at A and r1 at C: tails, horns, cables, tentacles */
function curveTube(x, y, z, ax, ay, az, bx, by, bz, cx, cy, cz, r0, r1) {
  var N = 8, best = 1e9, px = ax, py = ay, pz = az;
  for (var i = 1; i <= N; i++) {
    var t = i / N, u = 1 - t, w0 = u * u, w1 = 2 * u * t, w2 = t * t;
    var qx = w0 * ax + w1 * bx + w2 * cx, qy = w0 * ay + w1 * by + w2 * cy, qz = w0 * az + w1 * bz + w2 * cz;
    var ta = (i - 1) / N, d = taperedCapsule(x, y, z, px, py, pz, r0 + (r1 - r0) * ta, qx, qy, qz, r0 + (r1 - r0) * t);
    if (d < best) best = d;
    px = qx; py = qy; pz = qz;
  }
  return best;
}
function plane(y, h) { return y - h; }
function union(a, b) { return a < b ? a : b; }
function subtract(a, b) { return a > -b ? a : -b; }
function intersect(a, b) { return a > b ? a : b; }
function smin(a, b, k) { var h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
function smax(a, b, k) { return -smin(-a, -b, k); }
function ssub(a, b, k) { return smax(a, -b, k); }
function sint(a, b, k) { return smax(a, b, k); }
function onion(d, t) { return Math.abs(d) - t; }
function rot2u(a, u, v) { return u * Math.cos(a) - v * Math.sin(a); }
function rot2v(a, u, v) { return u * Math.sin(a) + v * Math.cos(a); }
/* fold a plane point into one sector of an n-fold radial pattern (gears, petals, spokes, columns) */
function polarU(a, b, n) { var s = TAU / n, ang = Math.atan2(b, a), f = ((ang + s * 0.5) % s + s) % s - s * 0.5; return Math.sqrt(a * a + b * b) * Math.cos(f); }
function polarV(a, b, n) { var s = TAU / n, ang = Math.atan2(b, a), f = ((ang + s * 0.5) % s + s) % s - s * 0.5; return Math.sqrt(a * a + b * b) * Math.sin(f); }
/* revolve: pass the profile radius for this height (use ramp()); a lathe/turning solid */
function lathe(x, y, z, r) { return (Math.sqrt(x * x + z * z) - r) * 0.85; }
/* smooth interpolation across evenly spaced control values: ramp(t01, v0, v1, v2, ...) */
function ramp(t) {
  var n = arguments.length - 1; if (n < 1) return 0;
  var f = clamp(t, 0, 1) * (n - 1), i = Math.floor(f); if (i >= n - 1) return arguments[n];
  var u = f - i; u = u * u * (3 - 2 * u); return arguments[1 + i] * (1 - u) + arguments[2 + i] * u;
}
/* periodic ridge in [0,1]: 1 on the lines, 0 between them (panel lines, grooves, ribs, scales) */
function ridge(v, period, width) { var f = Math.abs((((v / period) % 1) + 1) % 1 - 0.5) * period; return smoothstep(width, 0, f); }
function hash3(x, y, z) { var h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
function noise3(x, y, z) {
  var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  function h(a, b, c) { return hash3(ix + a, iy + b, iz + c) * 2 - 1; }
  var x00 = mix(h(0, 0, 0), h(1, 0, 0), fx), x10 = mix(h(0, 1, 0), h(1, 1, 0), fx), x01 = mix(h(0, 0, 1), h(1, 0, 1), fx), x11 = mix(h(0, 1, 1), h(1, 1, 1), fx);
  return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz);
}
function fbm(x, y, z, oct) { var s = 0, a = 0.5, f = 1; for (var i = 0; i < (oct || 4); i++) { s += a * noise3(x * f, y * f, z * f); f *= 2; a *= 0.5; } return s; }
/* Voronoi F1 distance (cell size 1): scales, leather, cobbles, cracked stone, hammered metal */
function cells3(x, y, z) {
  var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), best = 9;
  for (var k = -1; k <= 1; k++) for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) {
    var cx = ix + i, cy = iy + j, cz = iz + k;
    var px = cx + hash3(cx, cy, cz), py = cy + hash3(cx + 17.1, cy + 3.7, cz + 9.2), pz = cz + hash3(cx + 5.3, cy + 29.9, cz + 13.1);
    var dx = x - px, dy = y - py, dz = z - pz, d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
function rgb(r, g, b) { return [r, g, b]; }
function hex(h) { return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]; }
function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function hsl(h, s, l) {
  h = fract(h); var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h * 6) % 2 - 1)), m = l - c / 2, r = 0, g = 0, b = 0, k = Math.floor(h * 6);
  if (k === 0) { r = c; g = x; } else if (k === 1) { r = x; g = c; } else if (k === 2) { g = c; b = x; } else if (k === 3) { g = x; b = c; } else if (k === 4) { r = x; b = c; } else { r = c; b = x; }
  return [r + m, g + m, b + m];
}
function lighten(c, t) { return [c[0] + (1 - c[0]) * t, c[1] + (1 - c[1]) * t, c[2] + (1 - c[2]) * t]; }
function darken(c, t) { return [c[0] * (1 - t), c[1] * (1 - t), c[2] * (1 - t)]; }

var TOOL_NAMES = ["sphere","box","roundBox","cylinder","roundCylinder","capsule","taperedCapsule","torus","cone","cappedCone","roundCone","hexPrism","octahedron","pyramid","ellipsoid","curveTube","plane","union","subtract","intersect","smin","smax","ssub","sint","onion","rot2u","rot2v","polarU","polarV","lathe","ramp","ridge","clamp","mix","smoothstep","fract","hash3","noise3","fbm","cells3","rgb","hex","mixc","hsl","lighten","darken","PI","TAU"];
var TOOL_VALUES = [sphere,box,roundBox,cylinder,roundCylinder,capsule,taperedCapsule,torus,cone,cappedCone,roundCone,hexPrism,octahedron,pyramid,ellipsoid,curveTube,plane,union,subtract,intersect,smin,smax,ssub,sint,onion,rot2u,rot2v,polarU,polarV,lathe,ramp,ridge,clamp,mix,smoothstep,fract,hash3,noise3,fbm,cells3,rgb,hex,mixc,hsl,lighten,darken,PI,TAU];

function compile(code) {
  var body = code + "\n;return { sdf: typeof sdf === 'function' ? sdf : null, color: typeof color === 'function' ? color : null, surface: typeof surface === 'function' ? surface : null, displace: typeof displace === 'function' ? displace : null, material: (typeof material === 'object' && material) ? material : null, bounds: (typeof bounds === 'object' && bounds) ? bounds : null };";
  var fn = new Function(TOOL_NAMES.join(","), body);
  return fn.apply(null, TOOL_VALUES);
}

/* ============================================================ typed grow-arrays */
function GrowF32(cap) { this.a = new Float32Array(cap || 1024); this.n = 0; }
GrowF32.prototype.push3 = function (x, y, z) {
  if (this.n + 3 > this.a.length) { var b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
  this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
};
function GrowU32(cap) { this.a = new Uint32Array(cap || 1024); this.n = 0; }
GrowU32.prototype.push4 = function (p, q, r, s) {
  if (this.n + 4 > this.a.length) { var b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
  this.a[this.n++] = p; this.a[this.n++] = q; this.a[this.n++] = r; this.a[this.n++] = s;
};

/* ================================================================ surface nets */
var CUBE_EDGES = new Int32Array(24), EDGE_TABLE = new Int32Array(256);
(function () {
  var k = 0;
  for (var i = 0; i < 8; i++) for (var j = 1; j <= 4; j <<= 1) { var p = i ^ j; if (i <= p) { CUBE_EDGES[k++] = i; CUBE_EDGES[k++] = p; } }
  for (var m = 0; m < 256; m++) {
    var em = 0;
    for (var e = 0; e < 24; e += 2) { var a = !!(m & (1 << CUBE_EDGES[e])), b = !!(m & (1 << CUBE_EDGES[e + 1])); em |= a !== b ? (1 << (e >> 1)) : 0; }
    EDGE_TABLE[m] = em;
  }
})();

function surfaceNets(data, dx, dy, dz) {
  var verts = new GrowF32(65536), quads = new GrowU32(65536);
  var R = [1, dx + 1, (dx + 1) * (dy + 1)], buf = new Int32Array(R[2] * 2), grid = new Float32Array(8), x = [0, 0, 0], bufNo = 1, n = 0, vcount = 0;
  for (x[2] = 0; x[2] < dz - 1; ++x[2], n += dx, bufNo ^= 1, R[2] = -R[2]) {
    var m = 1 + (dx + 1) * (1 + bufNo * (dy + 1));
    for (x[1] = 0; x[1] < dy - 1; ++x[1], ++n, m += 2) {
      for (x[0] = 0; x[0] < dx - 1; ++x[0], ++n, ++m) {
        var mask = 0, g = 0, idx = n;
        for (var k = 0; k < 2; ++k, idx += dx * (dy - 2)) for (var j = 0; j < 2; ++j, idx += dx - 2) for (var i = 0; i < 2; ++i, ++g, ++idx) { var p = data[idx]; grid[g] = p; mask |= p < 0 ? (1 << g) : 0; }
        if (mask === 0 || mask === 0xff) continue;
        var edgeMask = EDGE_TABLE[mask], v0 = 0, v1 = 0, v2 = 0, ec = 0;
        for (var ei = 0; ei < 12; ++ei) {
          if (!(edgeMask & (1 << ei))) continue;
          ++ec;
          var e0 = CUBE_EDGES[ei << 1], e1 = CUBE_EDGES[(ei << 1) + 1], g0 = grid[e0], g1 = grid[e1], t = g0 - g1;
          if (Math.abs(t) > 1e-9) t = g0 / t; else continue;
          for (var jj = 0, kk = 1; jj < 3; ++jj, kk <<= 1) {
            var a = e0 & kk, b = e1 & kk, add = a !== b ? (a ? 1 - t : t) : (a ? 1 : 0);
            if (jj === 0) v0 += add; else if (jj === 1) v1 += add; else v2 += add;
          }
        }
        var s = 1 / ec;
        buf[m] = vcount++;
        verts.push3(x[0] + s * v0, x[1] + s * v1, x[2] + s * v2);
        for (var ax = 0; ax < 3; ++ax) {
          if (!(edgeMask & (1 << ax))) continue;
          var iu = (ax + 1) % 3, iv = (ax + 2) % 3;
          if (x[iu] === 0 || x[iv] === 0) continue;
          var du = R[iu], dv = R[iv];
          if (mask & 1) quads.push4(buf[m], buf[m - du], buf[m - du - dv], buf[m - dv]);
          else quads.push4(buf[m], buf[m - dv], buf[m - du - dv], buf[m - du]);
        }
      }
    }
  }
  return { verts: verts.a.subarray(0, verts.n), quads: quads.a.subarray(0, quads.n) };
}

/* ============================================================ field sampling */
function fillGrid(probe, lo, hi, res, budgetMs, prog, maxCells) {
  var size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], longest = Math.max(size[0], size[1], size[2]);
  var h = longest / res, nx, ny, nz;
  for (var guard = 0; guard < 14; guard++) {
    nx = Math.ceil(size[0] / h) + 3; ny = Math.ceil(size[1] / h) + 3; nz = Math.ceil(size[2] / h) + 3;
    if (nx * ny * nz <= maxCells) break;
    h *= 1.08;
  }
  var o = [lo[0] - h, lo[1] - h, lo[2] - h];
  var data = new Float32Array(nx * ny * nz); data.fill(NaN);
  var BS = 8, last = Date.now(), t0 = Date.now(), evals = 0;
  var gx = Math.ceil((nx - 1) / BS), gy = Math.ceil((ny - 1) / BS), gz = Math.ceil((nz - 1) / BS), totalBlocks = gx * gy * gz, done = 0;
  for (var bz = 0; bz < gz; bz++) for (var by = 0; by < gy; by++) for (var bx = 0; bx < gx; bx++) {
    var x0 = bx * BS, y0 = by * BS, z0 = bz * BS, x1 = Math.min(x0 + BS, nx - 1), y1 = Math.min(y0 + BS, ny - 1), z1 = Math.min(z0 + BS, nz - 1);
    var cx = o[0] + ((x0 + x1) / 2) * h, cy = o[1] + ((y0 + y1) / 2) * h, cz = o[2] + ((z0 + z1) / 2) * h;
    var rad = Math.sqrt(((x1 - x0) * h) * ((x1 - x0) * h) + ((y1 - y0) * h) * ((y1 - y0) * h) + ((z1 - z0) * h) * ((z1 - z0) * h)) / 2;
    var dc = probe(cx, cy, cz); evals++;
    var far = Math.abs(dc) > rad * 1.6 + h;
    for (var kz = z0; kz <= z1; kz++) for (var ky = y0; ky <= y1; ky++) for (var kx = x0; kx <= x1; kx++) {
      var gi = kx + nx * (ky + ny * kz);
      if (far) { if (data[gi] !== data[gi]) data[gi] = dc; }
      else if (data[gi] !== data[gi] || data[gi] === dc) { data[gi] = probe(o[0] + kx * h, o[1] + ky * h, o[2] + kz * h); evals++; }
    }
    done++;
    var now = Date.now();
    if (now - last > 250) {
      last = now;
      var frac = done / totalBlocks, elapsed = now - t0;
      prog(0.1 + 0.42 * frac, "Sampling " + (nx * ny * nz / 1e6).toFixed(1) + "M field particles");
      if (frac > 0.2 && elapsed / frac > budgetMs * 1.35) return { retry: Math.max(0.45, Math.pow(budgetMs / (elapsed / frac), 1 / 2.4)) };
    }
  }
  for (var di = 0; di < data.length; di++) if (data[di] !== data[di]) data[di] = 1;
  return { data: data, nx: nx, ny: ny, nz: nz, o: o, h: h, evals: evals };
}


/* Resolve checkerboard faces (two diagonal corners inside): they make four quads share one edge (non-manifold).
   The cheaper pair of samples is flipped by a hair, then the neighbourhood is re-checked. */
function resolveAmbiguity(data, nx, ny, nz, h) {
  var sx = 1, sy = nx, sz = nx * ny, tiny = Math.max(h * 1e-3, 1e-7), flips = 0, work = [];
  function face(a, b, c, d) { /* a,b,c,d = (0,0) (1,0) (0,1) (1,1) corners of one grid face */
    var na = data[a] < 0, nb = data[b] < 0, nc = data[c] < 0, nd = data[d] < 0;
    if (na !== nd || nb !== nc || na === nb) return;
    var pairIn = na ? [a, d] : [b, c], pairOut = na ? [b, c] : [a, d];
    var costIn = Math.max(Math.abs(data[pairIn[0]]), Math.abs(data[pairIn[1]])), costOut = Math.max(Math.abs(data[pairOut[0]]), Math.abs(data[pairOut[1]]));
    if (costOut <= costIn) { data[pairOut[0]] = -tiny; data[pairOut[1]] = -tiny; work.push(pairOut[0], pairOut[1]); }
    else { data[pairIn[0]] = tiny; data[pairIn[1]] = tiny; work.push(pairIn[0], pairIn[1]); }
    flips++;
  }
  for (var k = 0; k < nz - 1; k++) for (var j = 0; j < ny - 1; j++) {
    var base = nx * (j + ny * k);
    for (var i = 0; i < nx - 1; i++) {
      var p = base + i, v0 = data[p] < 0;
      if (v0 === (data[p + sx] < 0) && v0 === (data[p + sy] < 0) && v0 === (data[p + sx + sy] < 0) && v0 === (data[p + sz] < 0) && v0 === (data[p + sx + sz] < 0) && v0 === (data[p + sy + sz] < 0)) continue;
      face(p, p + sx, p + sy, p + sx + sy);
      face(p, p + sx, p + sz, p + sx + sz);
      face(p, p + sy, p + sz, p + sy + sz);
    }
  }
  var guard = 0;
  while (work.length && guard++ < 200000) {
    var q = work.pop(), qi = q % nx, qj = Math.floor(q / nx) % ny, qk = Math.floor(q / (nx * ny));
    for (var dk = -1; dk <= 0; dk++) for (var dj = -1; dj <= 0; dj++) for (var di = -1; di <= 0; di++) {
      var ci = qi + di, cj = qj + dj, ck = qk + dk;
      if (ci < 0 || cj < 0 || ck < 0 || ci >= nx - 1 || cj >= ny - 1 || ck >= nz - 1) continue;
      var pp = ci + nx * (cj + ny * ck);
      face(pp, pp + sx, pp + sy, pp + sx + sy); face(pp, pp + sx, pp + sz, pp + sx + sz); face(pp, pp + sy, pp + sz, pp + sy + sz);
    }
  }
  return flips;
}

function rng32(seed) { var a = seed >>> 0 || 1; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* ================================================================== mesh tools */
/* CSR adjacency: unique neighbours and incident quads per vertex */
function buildAdjacency(V, Q) {
  var nQ = Q.length >> 2, cnt = new Int32Array(V + 1), i, k;
  for (i = 0; i < nQ; i++) for (k = 0; k < 4; k++) { cnt[Q[i * 4 + k] + 1] += 2; }
  for (i = 0; i < V; i++) cnt[i + 1] += cnt[i];
  var fill = cnt.slice(0, V), nb = new Int32Array(cnt[V]);
  for (i = 0; i < nQ; i++) for (k = 0; k < 4; k++) {
    var a = Q[i * 4 + k], b = Q[i * 4 + ((k + 1) & 3)];
    nb[fill[a]++] = b; nb[fill[b]++] = a;
  }
  var start = new Int32Array(V + 1), out = new Int32Array(nb.length), w = 0;
  for (i = 0; i < V; i++) {
    start[i] = w;
    var s = cnt[i], e = cnt[i + 1], seg = nb.subarray(s, e); seg.sort();
    var prev = -1;
    for (k = 0; k < seg.length; k++) { if (seg[k] !== prev) { out[w++] = seg[k]; prev = seg[k]; } }
  }
  start[V] = w;
  var qc = new Int32Array(V + 1);
  for (i = 0; i < nQ; i++) for (k = 0; k < 4; k++) qc[Q[i * 4 + k] + 1]++;
  for (i = 0; i < V; i++) qc[i + 1] += qc[i];
  var qf = qc.slice(0, V), ql = new Int32Array(qc[V]);
  for (i = 0; i < nQ; i++) for (k = 0; k < 4; k++) ql[qf[Q[i * 4 + k]]++] = i;
  return { start: start, nbr: out.subarray(0, w), qstart: qc, qlist: ql };
}

/* exact-SDF gradient (tetrahedron technique, 4 evaluations). Writes GRAD = unit normal, returns the mean distance. */
var GRAD = [0, 0, 1];
function gradientAt(sdf, x, y, z, e) {
  var a = sdf(x + e, y - e, z - e), b = sdf(x - e, y - e, z + e), c = sdf(x - e, y + e, z - e), d = sdf(x + e, y + e, z + e);
  var gx = a - b - c + d, gy = -a - b + c + d, gz = -a + b - c + d, l = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (l > 1e-12) { GRAD[0] = gx / l; GRAD[1] = gy / l; GRAD[2] = gz / l; }
  return (a + b + c + d) * 0.25;
}

/* feature-preserving relocation: minimise sum (n_u . (x - p_u))^2 + lambda |x - p_v|^2 over the 1-ring planes */
function relaxQEF(P, N, adj, V, maxMove, lambda, passes) {
  var tmp = new Float32Array(V * 3);
  for (var pass = 0; pass < passes; pass++) {
    for (var v = 0; v < V; v++) {
      var px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
      var a00 = lambda, a01 = 0, a02 = 0, a11 = lambda, a12 = 0, a22 = lambda, b0 = lambda * px, b1 = lambda * py, b2 = lambda * pz;
      var s = adj.start[v], e = adj.start[v + 1];
      for (var t = -1, nn = e - s; t < nn; t++) {
        var u = t < 0 ? v : adj.nbr[s + t];
        var nx = N[u * 3], ny = N[u * 3 + 1], nz = N[u * 3 + 2];
        var d = nx * P[u * 3] + ny * P[u * 3 + 1] + nz * P[u * 3 + 2];
        a00 += nx * nx; a01 += nx * ny; a02 += nx * nz; a11 += ny * ny; a12 += ny * nz; a22 += nz * nz;
        b0 += nx * d; b1 += ny * d; b2 += nz * d;
      }
      var det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
      var rx = px, ry = py, rz = pz;
      if (Math.abs(det) > 1e-9) {
        var i00 = (a11 * a22 - a12 * a12) / det, i01 = (a02 * a12 - a01 * a22) / det, i02 = (a01 * a12 - a02 * a11) / det;
        var i11 = (a00 * a22 - a02 * a02) / det, i12 = (a01 * a02 - a00 * a12) / det, i22 = (a00 * a11 - a01 * a01) / det;
        rx = i00 * b0 + i01 * b1 + i02 * b2; ry = i01 * b0 + i11 * b1 + i12 * b2; rz = i02 * b0 + i12 * b1 + i22 * b2;
        var mx = rx - px, my = ry - py, mz = rz - pz, ml = Math.sqrt(mx * mx + my * my + mz * mz);
        if (ml > maxMove) { var k = maxMove / ml; rx = px + mx * k; ry = py + my * k; rz = pz + mz * k; }
      }
      tmp[v * 3] = rx; tmp[v * 3 + 1] = ry; tmp[v * 3 + 2] = rz;
    }
    P.set(tmp);
  }
}

/* one all-quad subdivision step: edge midpoints + face centres become new vertices */
function subdivide(P, Q) {
  var V = P.length / 3, nQ = Q.length >> 2, edges = new Map(), newPos = [], count = V;
  var key = function (a, b) { return a < b ? a * 4194304 + b : b * 4194304 + a; };
  var mids = new Int32Array(nQ * 4), centres = new Int32Array(nQ);
  var i, k;
  for (i = 0; i < nQ; i++) {
    for (k = 0; k < 4; k++) {
      var a = Q[i * 4 + k], b = Q[i * 4 + ((k + 1) & 3)], kk = key(a, b), id = edges.get(kk);
      if (id === undefined) { id = count++; edges.set(kk, id); newPos.push((P[a * 3] + P[b * 3]) * 0.5, (P[a * 3 + 1] + P[b * 3 + 1]) * 0.5, (P[a * 3 + 2] + P[b * 3 + 2]) * 0.5); }
      mids[i * 4 + k] = id;
    }
  }
  for (i = 0; i < nQ; i++) {
    centres[i] = count++;
    var a0 = Q[i * 4], a1 = Q[i * 4 + 1], a2 = Q[i * 4 + 2], a3 = Q[i * 4 + 3];
    newPos.push((P[a0 * 3] + P[a1 * 3] + P[a2 * 3] + P[a3 * 3]) * 0.25, (P[a0 * 3 + 1] + P[a1 * 3 + 1] + P[a2 * 3 + 1] + P[a3 * 3 + 1]) * 0.25, (P[a0 * 3 + 2] + P[a1 * 3 + 2] + P[a2 * 3 + 2] + P[a3 * 3 + 2]) * 0.25);
  }
  var P2 = new Float32Array(count * 3); P2.set(P); P2.set(newPos, V * 3);
  var Q2 = new Uint32Array(nQ * 16);
  for (i = 0; i < nQ; i++) {
    var A = Q[i * 4], B = Q[i * 4 + 1], C = Q[i * 4 + 2], D = Q[i * 4 + 3], mab = mids[i * 4], mbc = mids[i * 4 + 1], mcd = mids[i * 4 + 2], mda = mids[i * 4 + 3], f = centres[i], o = i * 16;
    Q2[o] = A; Q2[o + 1] = mab; Q2[o + 2] = f; Q2[o + 3] = mda;
    Q2[o + 4] = mab; Q2[o + 5] = B; Q2[o + 6] = mbc; Q2[o + 7] = f;
    Q2[o + 8] = f; Q2[o + 9] = mbc; Q2[o + 10] = C; Q2[o + 11] = mcd;
    Q2[o + 12] = mda; Q2[o + 13] = f; Q2[o + 14] = mcd; Q2[o + 15] = D;
  }
  return { P: P2, Q: Q2, firstNew: V };
}

function faceNormal(P, Q, i, out) { /* unit normal of one quad from its diagonals; returns |cross| (= 2 x area) */
  var a = Q[i * 4] * 3, b = Q[i * 4 + 1] * 3, c = Q[i * 4 + 2] * 3, d = Q[i * 4 + 3] * 3;
  var ux = P[c] - P[a], uy = P[c + 1] - P[a + 1], uz = P[c + 2] - P[a + 2], wx = P[d] - P[b], wy = P[d + 1] - P[b + 1], wz = P[d + 2] - P[b + 2];
  var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l > 1e-20) { out[0] = nx / l; out[1] = ny / l; out[2] = nz / l; } else { out[0] = 0; out[1] = 0; out[2] = 0; }
  return l;
}

/* ====================================================================== main */
var post = function (msg, transfer) { self.postMessage(msg, transfer || []); };

self.onmessage = function (ev) {
  var req = ev.data || {};
  try { run(req); } catch (err) { post({ type: "error", id: req.id, message: String(err && err.message ? err.message : err) }); }
};

function run(req) {
  var prog = function (f, label) { post({ type: "progress", id: req.id, fraction: f, label: label }); };
  var started = Date.now();
  var mobile = !!req.mobile;
  prog(0.02, "Compiling shape code");
  var program = compile(String(req.code || ""));
  if (!program.sdf) throw new Error("The code must define function sdf(x, y, z).");
  var sdf = program.sdf, colorFn = program.color, surfaceFn = program.surface, displaceFn = program.displace;
  var probe = function (x, y, z) { var d = sdf(x, y, z); if (typeof d !== "number" || d !== d) throw new Error("sdf returned " + d + " at (" + x.toFixed(2) + "," + y.toFixed(2) + "," + z.toFixed(2) + ") - it must return a finite number."); return d; };
  var safe = function (x, y, z) { var d = sdf(x, y, z); return d === d ? d : 1; };

  /* 1. bounds: author-supplied, or probed (near-surface samples count, so thin parts are not clipped) */
  prog(0.05, "Probing the shape");
  var lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], hit = 0;
  var B = program.bounds && program.bounds.min && program.bounds.max ? program.bounds : null;
  var N0 = 56, ext = 2.6, sp = (2 * ext) / (N0 - 1);
  for (var iz = 0; iz < N0; iz++) for (var iy = 0; iy < N0; iy++) for (var ix = 0; ix < N0; ix++) {
    var px = -ext + sp * ix, py = -ext + sp * iy, pz = -ext + sp * iz;
    if (probe(px, py, pz) < sp * 0.72) { hit++; if (px < lo[0]) lo[0] = px; if (py < lo[1]) lo[1] = py; if (pz < lo[2]) lo[2] = pz; if (px > hi[0]) hi[0] = px; if (py > hi[1]) hi[1] = py; if (pz > hi[2]) hi[2] = pz; }
  }
  if (hit) for (var q = 0; q < 3; q++) { lo[q] -= sp * 0.35; hi[q] += sp * 0.35; }
  /* author bounds only ever GROW the box (a too-tight guess must never slice the model) */
  if (B) for (var bq = 0; bq < 3; bq++) { var bl = Number(B.min[bq]), bh = Number(B.max[bq]); if (bl === bl && bh === bh) { lo[bq] = hit ? Math.min(lo[bq], bl) : bl; hi[bq] = hit ? Math.max(hi[bq], bh) : bh; } hit = hit || 1; }
  if (!hit) throw new Error("The shape is empty: sdf() is never negative inside the box -2.6..2.6. Build the model around the origin, sized roughly 1 to 2 units.");
  var longest0 = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (longest0 > 7) throw new Error("The shape is too large. Keep it within about 2.5 units of the origin.");

  /* 2. fill the field (auto-lowers the resolution if the code is too slow for the time budget) */
  var res = Math.max(48, Math.min(360, req.resolution || 150)), budget = req.budgetMs || 24000, tries = 0, grid = null;
  var maxCells = req.maxCells || (mobile ? 9e6 : 26e6);
  while (true) {
    grid = fillGrid(probe, lo, hi, res, budget, prog, maxCells);
    if (grid.data) break;
    if (++tries > 3) throw new Error("This shape is too slow to evaluate (its sdf is very expensive). Use fewer parts or simpler maths.");
    res = Math.max(48, Math.floor(res * grid.retry));
    prog(0.1, "Shape is heavy - lowering resolution to " + res);
  }
  var nx = grid.nx, ny = grid.ny, nz = grid.nz, o = grid.o, h = grid.h, data = grid.data;
  var ambiguityFixes = resolveAmbiguity(data, nx, ny, nz, h);

  /* 3. fuse into one welded all-quad surface */
  prog(0.54, "Fusing particles into one mesh");
  var sn = surfaceNets(data, nx, ny, nz), V0 = sn.verts.length / 3, Q0 = sn.quads.length / 4;
  if (V0 < 20 || Q0 < 10) throw new Error("The shape produced almost no surface (" + V0 + " vertices). Make the model bigger and make sure sdf() is negative inside the solid.");
  if (V0 > 1900000) throw new Error("Too many vertices (" + V0 + "). Lower the resolution.");

  /* 4. clean topology: drop floating debris (tiny disconnected islands) and degenerate quads */
  prog(0.58, "Cleaning topology");
  var parent = new Int32Array(V0); for (var u = 0; u < V0; u++) parent[u] = u;
  var find = function (a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  var qa = sn.quads;
  for (var qi = 0; qi < Q0; qi++) { var r0 = find(qa[qi * 4]); for (var kq = 1; kq < 4; kq++) { var r1 = find(qa[qi * 4 + kq]); if (r1 !== r0) parent[r1] = r0; } }
  var count = new Int32Array(V0), bestCount = 0;
  for (var qj = 0; qj < Q0; qj++) { var rr = find(qa[qj * 4]); count[rr]++; if (count[rr] > bestCount) bestCount = count[rr]; }
  var minKeep = Math.max(12, Math.floor(bestCount * 0.012)), comps = 0, keptComps = 0;
  for (var cr = 0; cr < V0; cr++) if (count[cr] > 0) { comps++; if (count[cr] >= minKeep) keptComps++; }
  var remap = new Int32Array(V0).fill(-1), nv = 0, keep = new GrowU32(Q0 * 4 + 16);
  for (var qk = 0; qk < Q0; qk++) {
    var rk = find(qa[qk * 4]); if (count[rk] < minKeep) continue;
    var i0 = qa[qk * 4], i1 = qa[qk * 4 + 1], i2 = qa[qk * 4 + 2], i3 = qa[qk * 4 + 3];
    if (i0 === i1 || i1 === i2 || i2 === i3 || i3 === i0 || i0 === i2 || i1 === i3) continue;
    for (var kk = 0; kk < 4; kk++) { var vv = qa[qk * 4 + kk]; if (remap[vv] < 0) remap[vv] = nv++; }
    keep.push4(remap[i0], remap[i1], remap[i2], remap[i3]);
  }
  var oldV = new Int32Array(nv); for (var ov = 0; ov < V0; ov++) if (remap[ov] >= 0) oldV[remap[ov]] = ov;
  var Qm = keep.a.slice(0, keep.n);

  /* 5. world-space vertices, exact normals + projection, then feature-preserving relocation */
  prog(0.62, "Snapping the surface");
  var P = new Float32Array(nv * 3), Nrm = new Float32Array(nv * 3);
  var eps = h * 0.35, lastT = Date.now();
  for (var v = 0; v < nv; v++) {
    var ov2 = oldV[v];
    var x = o[0] + sn.verts[ov2 * 3] * h, y = o[1] + sn.verts[ov2 * 3 + 1] * h, z = o[2] + sn.verts[ov2 * 3 + 2] * h;
    var dd = gradientAt(safe, x, y, z, eps);
    var step = Math.max(-h, Math.min(h, dd));
    x -= GRAD[0] * step; y -= GRAD[1] * step; z -= GRAD[2] * step;
    P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z; Nrm[v * 3] = GRAD[0]; Nrm[v * 3 + 1] = GRAD[1]; Nrm[v * 3 + 2] = GRAD[2];
    if (Date.now() - lastT > 250) { lastT = Date.now(); prog(0.62 + 0.08 * (v / nv), "Snapping the surface"); }
  }
  var adj = buildAdjacency(nv, Qm);
  prog(0.72, "Sharpening hard edges");
  relaxQEF(P, Nrm, adj, nv, h * 0.75, 0.07, 2);
  /* re-seat on the exact surface after relocation (vertices that drifted off get a Newton step) */
  for (var v2 = 0; v2 < nv; v2++) {
    var x2 = P[v2 * 3], y2 = P[v2 * 3 + 1], z2 = P[v2 * 3 + 2], d2 = safe(x2, y2, z2);
    if (Math.abs(d2) > h * 0.12) { var st = Math.max(-h * 0.6, Math.min(h * 0.6, d2)); P[v2 * 3] = x2 - Nrm[v2 * 3] * st; P[v2 * 3 + 1] = y2 - Nrm[v2 * 3 + 1] * st; P[v2 * 3 + 2] = z2 - Nrm[v2 * 3 + 2] * st; }
  }

  /* 6. orientation check: faces must agree with the field gradient (outward) */
  var fn3 = [0, 0, 0], agree = 0, disagree = 0, nQm = Qm.length >> 2;
  for (var fq = 0; fq < nQm; fq += Math.max(1, nQm >> 12)) {
    faceNormal(P, Qm, fq, fn3);
    var gx = (Nrm[Qm[fq * 4] * 3] + Nrm[Qm[fq * 4 + 2] * 3]) * 0.5, gy = (Nrm[Qm[fq * 4] * 3 + 1] + Nrm[Qm[fq * 4 + 2] * 3 + 1]) * 0.5, gz = (Nrm[Qm[fq * 4] * 3 + 2] + Nrm[Qm[fq * 4 + 2] * 3 + 2]) * 0.5;
    if (fn3[0] * gx + fn3[1] * gy + fn3[2] * gz >= 0) agree++; else disagree++;
  }
  if (disagree > agree) { for (var fi = 0; fi < nQm; fi++) { var t1 = Qm[fi * 4 + 1]; Qm[fi * 4 + 1] = Qm[fi * 4 + 3]; Qm[fi * 4 + 3] = t1; } }

  /* 7. refinement: every level turns each quad into four and re-projects the new vertices onto the exact surface */
  var refineWanted = Math.max(0, Math.min(2, req.refine | 0)), vertexBudget = req.vertexBudget || (mobile ? 330000 : 950000), levels = 0;
  var edgeLen = h;
  while (levels < refineWanted && P.length / 3 * 4 <= vertexBudget && Date.now() - started < budget * 2.2) {
    prog(0.76 + 0.06 * levels, "Refining topology (level " + (levels + 1) + ")");
    var sd = subdivide(P, Qm), first = sd.firstNew, VV = sd.P.length / 3;
    var nrm2 = new Float32Array(VV * 3); nrm2.set(Nrm);
    edgeLen *= 0.5;
    var e2 = edgeLen * 0.4;
    for (var nvx = first; nvx < VV; nvx++) {
      var xx = sd.P[nvx * 3], yy = sd.P[nvx * 3 + 1], zz = sd.P[nvx * 3 + 2];
      var dn = gradientAt(safe, xx, yy, zz, e2), st2 = Math.max(-edgeLen * 2, Math.min(edgeLen * 2, dn));
      sd.P[nvx * 3] = xx - GRAD[0] * st2; sd.P[nvx * 3 + 1] = yy - GRAD[1] * st2; sd.P[nvx * 3 + 2] = zz - GRAD[2] * st2;
      nrm2[nvx * 3] = GRAD[0]; nrm2[nvx * 3 + 1] = GRAD[1]; nrm2[nvx * 3 + 2] = GRAD[2];
    }
    P = sd.P; Nrm = nrm2; Qm = sd.Q; nv = VV;
    adj = buildAdjacency(nv, Qm);
    relaxQEF(P, Nrm, adj, nv, edgeLen * 0.75, 0.07, 1);
    for (var v3 = 0; v3 < nv; v3++) {
      var xq = P[v3 * 3], yq = P[v3 * 3 + 1], zq = P[v3 * 3 + 2], dq = safe(xq, yq, zq);
      if (Math.abs(dq) > edgeLen * 0.1) { var sq = Math.max(-edgeLen * 0.8, Math.min(edgeLen * 0.8, dq)); P[v3 * 3] = xq - Nrm[v3 * 3] * sq; P[v3 * 3 + 1] = yq - Nrm[v3 * 3 + 1] * sq; P[v3 * 3 + 2] = zq - Nrm[v3 * 3 + 2] * sq; }
    }
    levels++;
  }

  /* 8. micro-displacement along the surface normal (real geometry, finer than the voxel grid) */
  var displaced = false;
  if (displaceFn) {
    prog(0.84, "Carving micro-detail");
    var cap = Math.max(edgeLen * 6, 0.02);
    for (var dv = 0; dv < nv; dv++) {
      var dx0 = P[dv * 3], dy0 = P[dv * 3 + 1], dz0 = P[dv * 3 + 2], dm = 0;
      try { dm = Number(displaceFn(dx0, dy0, dz0)); } catch (de) { dm = 0; }
      if (!(dm === dm)) dm = 0;
      dm = Math.max(-cap, Math.min(cap, dm));
      P[dv * 3] = dx0 + Nrm[dv * 3] * dm; P[dv * 3 + 1] = dy0 + Nrm[dv * 3 + 1] * dm; P[dv * 3 + 2] = dz0 + Nrm[dv * 3 + 2] * dm;
    }
    displaced = true;
  }

  /* 9. crease-aware normals: group the quads around each vertex by normal similarity, split vertices where groups differ */
  prog(0.87, "Building smooth shading");
  var adj2 = buildAdjacency(nv, Qm), nQ = Qm.length >> 2;
  var faceN = new Float32Array(nQ * 3), faceA = new Float32Array(nQ), tmpn = [0, 0, 0];
  for (var fqi = 0; fqi < nQ; fqi++) { var la = faceNormal(P, Qm, fqi, tmpn); faceN[fqi * 3] = tmpn[0]; faceN[fqi * 3 + 1] = tmpn[1]; faceN[fqi * 3 + 2] = tmpn[2]; faceA[fqi] = la; }
  var CREASE = 0.7071;  /* cos 45 degrees */
  var outBase = nv, extra = [], corner = new Uint32Array(nQ * 4), creaseVerts = 0;
  var vN = new Float32Array(nv * 3);
  var groupNx = [], groupNy = [], groupNz = [], groupQuads = [];
  for (var vi = 0; vi < nv; vi++) {
    var qs = adj2.qstart[vi], qe = adj2.qstart[vi + 1];
    groupNx.length = 0; groupNy.length = 0; groupNz.length = 0; groupQuads.length = 0;
    for (var qq = qs; qq < qe; qq++) {
      var fq2 = adj2.qlist[qq], fx = faceN[fq2 * 3], fy = faceN[fq2 * 3 + 1], fz = faceN[fq2 * 3 + 2], fa = faceA[fq2], placed = -1;
      for (var gI = 0; gI < groupNx.length; gI++) {
        var gl = Math.sqrt(groupNx[gI] * groupNx[gI] + groupNy[gI] * groupNy[gI] + groupNz[gI] * groupNz[gI]) || 1;
        if ((groupNx[gI] * fx + groupNy[gI] * fy + groupNz[gI] * fz) / gl >= CREASE) { placed = gI; break; }
      }
      if (placed < 0) { groupNx.push(0); groupNy.push(0); groupNz.push(0); groupQuads.push([]); placed = groupNx.length - 1; }
      groupNx[placed] += fx * fa; groupNy[placed] += fy * fa; groupNz[placed] += fz * fa; groupQuads[placed].push(fq2);
    }
    for (var gJ = 0; gJ < groupNx.length; gJ++) {
      var gnl = Math.sqrt(groupNx[gJ] * groupNx[gJ] + groupNy[gJ] * groupNy[gJ] + groupNz[gJ] * groupNz[gJ]) || 1;
      var snx = groupNx[gJ] / gnl, sny = groupNy[gJ] / gnl, snz = groupNz[gJ] / gnl;
      /* a smooth vertex keeps the exact field normal; a crease or displaced vertex uses the faceted group normal */
      if (!displaced && groupNx.length === 1 && Nrm[vi * 3] * snx + Nrm[vi * 3 + 1] * sny + Nrm[vi * 3 + 2] * snz > 0.985) { snx = Nrm[vi * 3]; sny = Nrm[vi * 3 + 1]; snz = Nrm[vi * 3 + 2]; }
      var vid;
      if (gJ === 0) { vid = vi; vN[vi * 3] = snx; vN[vi * 3 + 1] = sny; vN[vi * 3 + 2] = snz; }
      else { vid = outBase + extra.length / 4; extra.push(vi, snx, sny, snz); creaseVerts++; }
      for (var gq = 0; gq < groupQuads[gJ].length; gq++) {
        var fq3 = groupQuads[gJ][gq];
        for (var ck = 0; ck < 4; ck++) if (Qm[fq3 * 4 + ck] === vi) corner[fq3 * 4 + ck] = vid;
      }
    }
  }
  var outV = outBase + extra.length / 4;
  var pos = new Float32Array(outV * 3), nor = new Float32Array(outV * 3), src = new Int32Array(outV);
  pos.set(P.subarray(0, nv * 3)); nor.set(vN);
  for (var si = 0; si < nv; si++) src[si] = si;
  for (var ei2 = 0, w2 = 0; ei2 < extra.length; ei2 += 4, w2++) {
    var nid = outBase + w2, ov3 = extra[ei2];
    src[nid] = ov3; pos[nid * 3] = P[ov3 * 3]; pos[nid * 3 + 1] = P[ov3 * 3 + 1]; pos[nid * 3 + 2] = P[ov3 * 3 + 2];
    nor[nid * 3] = extra[ei2 + 1]; nor[nid * 3 + 1] = extra[ei2 + 2]; nor[nid * 3 + 2] = extra[ei2 + 3];
  }

  /* 10. colour + PBR per vertex */
  prog(0.9, "Painting materials");
  var col = new Uint8Array(outV * 3), mat = new Uint8Array(outV * 3);
  var gm = program.material || {}, baseMetal = typeof gm.metallic === "number" ? gm.metallic : 0.15, baseRough = typeof gm.roughness === "number" ? gm.roughness : 0.55;
  var defaultCol = [0.78, 0.8, 0.86], lastP = Date.now();
  for (var cv = 0; cv < nv; cv++) {
    var cx2 = P[cv * 3], cy2 = P[cv * 3 + 1], cz2 = P[cv * 3 + 2], c = defaultCol, m0 = baseMetal, m1 = baseRough, m2 = 0;
    if (colorFn) { try { var cc = colorFn(cx2, cy2, cz2); if (cc && cc.length >= 3 && cc[0] === cc[0] && cc[1] === cc[1] && cc[2] === cc[2]) c = cc; } catch (err) { c = defaultCol; } }
    if (surfaceFn) { try { var sv = surfaceFn(cx2, cy2, cz2); if (sv && sv.length >= 2) { m0 = Number(sv[0]); m1 = Number(sv[1]); m2 = sv.length > 2 ? Number(sv[2]) : 0; } else if (sv && typeof sv === "object") { m0 = Number(sv.metallic); m1 = Number(sv.roughness); m2 = Number(sv.emissive) || 0; } } catch (err2) { m0 = baseMetal; m1 = baseRough; m2 = 0; } }
    if (!(m0 === m0)) m0 = baseMetal; if (!(m1 === m1)) m1 = baseRough; if (!(m2 === m2)) m2 = 0;
    var r8 = Math.max(0, Math.min(255, Math.round(c[0] * 255))), g8 = Math.max(0, Math.min(255, Math.round(c[1] * 255))), b8 = Math.max(0, Math.min(255, Math.round(c[2] * 255)));
    col[cv * 3] = r8; col[cv * 3 + 1] = g8; col[cv * 3 + 2] = b8;
    mat[cv * 3] = Math.max(0, Math.min(255, Math.round(m0 * 255))); mat[cv * 3 + 1] = Math.max(0, Math.min(255, Math.round(m1 * 255))); mat[cv * 3 + 2] = Math.max(0, Math.min(255, Math.round(m2 * 127.5)));
    if (Date.now() - lastP > 250) { lastP = Date.now(); prog(0.9 + 0.05 * (cv / nv), "Painting materials"); }
  }
  for (var dup = nv; dup < outV; dup++) {
    var sidx = src[dup];
    col[dup * 3] = col[sidx * 3]; col[dup * 3 + 1] = col[sidx * 3 + 1]; col[dup * 3 + 2] = col[sidx * 3 + 2];
    mat[dup * 3] = mat[sidx * 3]; mat[dup * 3 + 1] = mat[sidx * 3 + 1]; mat[dup * 3 + 2] = mat[sidx * 3 + 2];
  }
  var quads = corner;

  /* 11. topology report: boundary / non-manifold edges, valence regularity, quad aspect, area, volume */
  var E4 = nQ * 4, keys = new Float64Array(E4);
  for (var kq2 = 0; kq2 < nQ; kq2++) for (var ke = 0; ke < 4; ke++) {
    var a_ = Qm[kq2 * 4 + ke], b_ = Qm[kq2 * 4 + ((ke + 1) & 3)];
    keys[kq2 * 4 + ke] = a_ < b_ ? a_ * 4194304 + b_ : b_ * 4194304 + a_;
  }
  keys.sort();
  var boundary = 0, nonManifold = 0, uniqueEdges = 0;
  for (var kr = 0; kr < E4; ) { var kc = kr; while (kc < E4 && keys[kc] === keys[kr]) kc++; var run = kc - kr; uniqueEdges++; if (run === 1) boundary++; else if (run > 2) nonManifold++; kr = kc; }
  var regular = 0, irregular = 0;
  for (var rv = 0; rv < nv; rv++) { var val = adj2.start[rv + 1] - adj2.start[rv]; if (val === 4) regular++; else irregular++; }
  var area = 0, vol = 0, aspectSum = 0, aspectN = 0, badQuads = 0;
  for (var aq = 0; aq < nQ; aq++) {
    var A_ = Qm[aq * 4] * 3, B_ = Qm[aq * 4 + 1] * 3, C_ = Qm[aq * 4 + 2] * 3, D_ = Qm[aq * 4 + 3] * 3;
    area += faceA[aq] * 0.5;
    vol += (P[A_] * (P[B_ + 1] * P[C_ + 2] - P[B_ + 2] * P[C_ + 1]) - P[A_ + 1] * (P[B_] * P[C_ + 2] - P[B_ + 2] * P[C_]) + P[A_ + 2] * (P[B_] * P[C_ + 1] - P[B_ + 1] * P[C_])) / 6 + (P[A_] * (P[C_ + 1] * P[D_ + 2] - P[C_ + 2] * P[D_ + 1]) - P[A_ + 1] * (P[C_] * P[D_ + 2] - P[C_ + 2] * P[D_]) + P[A_ + 2] * (P[C_] * P[D_ + 1] - P[C_ + 1] * P[D_])) / 6;
    if (aq % 7 === 0) {
      var l1 = Math.hypot(P[B_] - P[A_], P[B_ + 1] - P[A_ + 1], P[B_ + 2] - P[A_ + 2]), l2 = Math.hypot(P[C_] - P[B_], P[C_ + 1] - P[B_ + 1], P[C_ + 2] - P[B_ + 2]);
      var asp = Math.max(l1, l2) / (Math.min(l1, l2) || 1e-9); aspectSum += asp; aspectN++; if (asp > 4) badQuads++;
    }
  }
  var eulerChar = nv - uniqueEdges + nQ, genus = (boundary === 0 && nonManifold === 0 && keptComps === 1) ? Math.round((2 - eulerChar) / 2) : -1;

  /* 12. scatter the particle cloud over the finished skin (area-weighted, stratified) */
  var want = Math.max(0, Math.min(3000000, req.particles || 0)), pts = new Float32Array(want * 3), pcol = new Uint8Array(want * 3);
  if (want > 0) {
    prog(0.96, "Scattering " + (want / 1e6).toFixed(1) + "M particles");
    var T = nQ * 2, cdf = new Float64Array(T), acc = 0;
    for (var t3 = 0; t3 < T; t3++) {
      var q3 = t3 >> 1, a0 = Qm[q3 * 4], a1 = Qm[q3 * 4 + 1 + (t3 & 1)], a2 = Qm[q3 * 4 + 2 + (t3 & 1)];
      var ux = P[a1 * 3] - P[a0 * 3], uy = P[a1 * 3 + 1] - P[a0 * 3 + 1], uz = P[a1 * 3 + 2] - P[a0 * 3 + 2], wx = P[a2 * 3] - P[a0 * 3], wy = P[a2 * 3 + 1] - P[a0 * 3 + 1], wz = P[a2 * 3 + 2] - P[a0 * 3 + 2];
      var cxp = uy * wz - uz * wy, cyp = uz * wx - ux * wz, czp = ux * wy - uy * wx;
      acc += Math.sqrt(cxp * cxp + cyp * cyp + czp * czp) * 0.5; cdf[t3] = acc;
    }
    var rnd = rng32(12345);
    for (var pi = 0; pi < want; pi++) {
      var target = ((pi + rnd()) / want) * acc, lo2 = 0, hi2 = T - 1;
      while (lo2 < hi2) { var mid = (lo2 + hi2) >> 1; if (cdf[mid] < target) lo2 = mid + 1; else hi2 = mid; }
      var tt = lo2, q2 = tt >> 1, b0 = Qm[q2 * 4], b1 = Qm[q2 * 4 + 1 + (tt & 1)], b2 = Qm[q2 * 4 + 2 + (tt & 1)];
      var r1s = Math.sqrt(rnd()), r2s = rnd(), wa = 1 - r1s, wb = r1s * (1 - r2s), wc = r1s * r2s;
      for (var kx = 0; kx < 3; kx++) {
        pts[pi * 3 + kx] = P[b0 * 3 + kx] * wa + P[b1 * 3 + kx] * wb + P[b2 * 3 + kx] * wc;
        pcol[pi * 3 + kx] = Math.round(col[b0 * 3 + kx] * wa + col[b1 * 3 + kx] * wb + col[b2 * 3 + kx] * wc);
      }
    }
  }
  var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (var bv = 0; bv < outV; bv++) for (var bk = 0; bk < 3; bk++) { var pv = pos[bv * 3 + bk]; if (pv < mn[bk]) mn[bk] = pv; if (pv > mx[bk]) mx[bk] = pv; }
  prog(0.99, "Packing the mesh");
  post({
    type: "done", id: req.id, positions: pos, normals: nor, colors: col, mats: mat, quads: quads, points: pts, pointColors: pcol,
    stats: {
      vertices: outV, quads: nQ, triangles: nQ * 2, particles: want, samples: nx * ny * nz, components: comps, keptComponents: keptComps,
      boundaryEdges: boundary, nonManifoldEdges: nonManifold, watertight: boundary === 0 && nonManifold === 0, resolution: Math.round(Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / h), voxel: h, ms: Date.now() - started,
      bounds: { min: mn, max: mx }, refineLevels: levels, creaseVertices: creaseVerts, ambiguityFixes: ambiguityFixes, displaced: displaced, edgeLength: edgeLen,
      regularPct: Math.round((regular / Math.max(1, regular + irregular)) * 1000) / 10, quadAspect: Math.round((aspectSum / Math.max(1, aspectN)) * 100) / 100, badQuadPct: Math.round((badQuads / Math.max(1, aspectN)) * 1000) / 10,
      surfaceArea: Math.round(area * 1000) / 1000, volume: Math.round(Math.abs(vol) * 1000) / 1000, eulerCharacteristic: eulerChar, genus: genus, pureQuad: true
    },
    material: { metallic: baseMetal, roughness: baseRough }
  }, [pos.buffer, nor.buffer, col.buffer, mat.buffer, quads.buffer, pts.buffer, pcol.buffer]);
}
`;
