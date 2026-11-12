/**
 * Prompt, examples and parsing helpers for Zeros Particle Forge v2 (model-written shape programs).
 * The four examples below are executed by the real forge pipeline in tests - they are known-good.
 */

export const FORGE_EXAMPLE_CAR = `// SPORTS CAR (hard surface). +x = front, +y = up, wheels on +/-z. Ground at y = -0.355. Mirror with Math.abs.
var WX = 0.62, WZ = 0.40, WY = -0.13;
function tireD(x, y, z) { return torus(Math.abs(x) - WX, Math.abs(z) - WZ, y - WY, 0.15, 0.075); }          // ring in the x-y plane, axis along z
function rimD(x, y, z) {
  var ax = Math.abs(x) - WX, ay = y - WY, az = Math.abs(z) - WZ;
  var disc = cylinder(ax, az - 0.045, ay, 0.12, 0.022);                                                    // dished rim face
  var u = polarU(ax, ay, 5), v = polarV(ax, ay, 5);                                                        // 5 spokes by folding space
  var spoke = roundBox(u - 0.07, v, az - 0.052, 0.062, 0.017, 0.014, 0.006);
  var hub = cylinder(ax, az - 0.06, ay, 0.03, 0.02);
  return smin(union(spoke, hub), subtract(disc, cylinder(ax, az - 0.045, ay, 0.095, 0.03)), 0.008);       // outer barrel + spokes + hub
}
function bodyD(x, y, z) {
  var chassis = roundBox(x, y + 0.02, z, 0.98, 0.13, 0.43, 0.09);
  var hood = roundBox(x - 0.52, y - 0.06, z, 0.48, 0.09, 0.40, 0.08);
  var tail = roundBox(x + 0.72, y - 0.07, z, 0.28, 0.10, 0.39, 0.08);
  var cabin = ellipsoid(x + 0.10, y - 0.20, z, 0.50, 0.22, 0.34);
  var d = smin(smin(smin(chassis, hood, 0.10), tail, 0.08), cabin, 0.16);
  d = union(d, roundBox(x + 0.93, y - 0.13, z, 0.07, 0.015, 0.40, 0.01));                                  // wing
  d = union(d, roundBox(x + 0.9, y - 0.06, Math.abs(z) - 0.28, 0.02, 0.07, 0.015, 0.005));                 // wing posts
  d = subtract(d, cylinder(Math.abs(x) - WX, Math.abs(z) - 0.45, y - WY, 0.255, 0.17));                     // wheel arches
  d = union(d, roundBox(x - 1.0, y + 0.1, z, 0.04, 0.025, 0.36, 0.01));                                     // front splitter
  d = union(d, capsule(x + 0.12, y - 0.27, Math.abs(z) - 0.30, 0.0, 0.0, 0.0, 0.1, 0.0, 0.0, 0.02));         // door mirrors? roof rails
  return d;
}
function sdf(x, y, z) {
  var axle = capsule(Math.abs(x) - WX, y - WY, z, 0, 0, -(WZ + 0.07), 0, 0, WZ + 0.07, 0.035);   // reaches into both hubs, so wheels and body are ONE solid
  return union(union(bodyD(x, y, z), union(tireD(x, y, z), rimD(x, y, z))), axle);
}
function isTire(x, y, z) { return tireD(x, y, z) < 0.012; }
function isRim(x, y, z) { return rimD(x, y, z) < 0.012; }
function isGlass(x, y, z) { return y > -0.05 && y < 0.2 && Math.abs(z) < 0.31 && x > -0.45 && x < 0.55 && !isTire(x, y, z); }
function isHead(x, y, z) { return x > 0.93 && y > -0.12 && y < -0.02 && Math.abs(z) > 0.16; }
function isTail(x, y, z) { return x < -0.97 && y > -0.12 && y < -0.02; }
function color(x, y, z) {
  if (isTire(x, y, z)) return hex(0x151515);
  if (isRim(x, y, z)) return hex(0xd7dce4);
  if (isGlass(x, y, z)) return hex(0x16202e);
  if (isHead(x, y, z)) return hex(0xfff2c0);
  if (isTail(x, y, z)) return hex(0xff1d1d);
  if (y < -0.2) return hex(0x1b1b20);
  return mixc(hex(0xa70f1a), hex(0xff3d48), smoothstep(-0.15, 0.25, y));
}
function surface(x, y, z) {                                                      // [metallic, roughness, emissive]
  if (isTire(x, y, z)) return [0.0, 0.9, 0];
  if (isRim(x, y, z)) return [1.0, 0.18, 0];
  if (isGlass(x, y, z)) return [0.0, 0.04, 0];
  if (isHead(x, y, z)) return [0.0, 0.1, 1.4];
  if (isTail(x, y, z)) return [0.0, 0.2, 1.0];
  if (y < -0.2) return [0.0, 0.8, 0];
  return [0.7, 0.2, 0];                                                          // clear-coated metallic paint
}
function displace(x, y, z) {
  if (isTire(x, y, z)) return -0.006 * ridge(Math.atan2(y - WY, Math.abs(x) - WX) * 0.15, 0.012, 0.003);   // tyre tread blocks
  if (Math.abs(z) > 0.3 && Math.abs(x - 0.12) < 0.012 && y > -0.12 && y < 0.1) return -0.006;           // door shut line
  return 0;
}
var material = { metallic: 0.6, roughness: 0.25 };
var bounds = { min: [-1.1, -0.4, -0.55], max: [1.15, 0.5, 0.55] };`;

export const FORGE_EXAMPLE_FOX = `// FOX (organic character). Faces +z, +y up, tail toward -z. Mirror left/right with ax = |x|. Blend parts with smin for soft joins.
function earD(x, y, z) { return taperedCapsule(Math.abs(x) - 0.17, y - 0.62, z - 0.36, 0, 0, 0, 0.1, 0.07, 0.30, -0.04, 0.02); }
function sdf(x, y, z) {
  var ax = Math.abs(x);
  var body = ellipsoid(x, y, z + 0.15, 0.33, 0.30, 0.50);
  var chest = ellipsoid(x, y + 0.03, z - 0.18, 0.28, 0.28, 0.30);
  var head = ellipsoid(x, y - 0.42, z - 0.42, 0.30, 0.25, 0.27);
  var cheek = ellipsoid(ax - 0.2, y - 0.37, z - 0.45, 0.13, 0.1, 0.13);               // fluffy cheek tufts
  var snout = taperedCapsule(x, y - 0.36, z - 0.58, 0, 0, 0, 0.12, 0, -0.02, 0.2, 0.05);
  var d = smin(body, chest, 0.2);
  d = smin(d, head, 0.16);
  d = smin(d, smin(snout, cheek, 0.06), 0.08);
  d = smin(d, earD(x, y, z), 0.06);
  var legF = taperedCapsule(ax - 0.17, y + 0.12, z - 0.22, 0, 0, 0, 0.085, 0, -0.42, 0.02, 0.06);
  var legB = taperedCapsule(ax - 0.19, y + 0.1, z + 0.45, 0, 0, 0, 0.11, 0, -0.42, 0.04, 0.065);
  d = smin(d, smin(legF, legB, 0.1), 0.09);
  var tailA = curveTube(x, y, z, 0, 0.02, -0.6, 0, 0.18, -0.95, 0, 0.42, -1.02, 0.09, 0.2);   // sweeping tail on a Bezier curve
  var tailB = ellipsoid(x, y - 0.34, z + 1.0, 0.17, 0.2, 0.3);
  d = smin(d, smin(tailA, tailB, 0.15), 0.1);
  return ssub(d, sphere(ax - 0.12, y - 0.47, z - 0.62, 0.035), 0.01);                       // eye sockets
}
function color(x, y, z) {
  var ax = Math.abs(x);
  if (sphere(ax - 0.12, y - 0.47, z - 0.62, 0.05) < 0) return hex(0x140d07);                // eyes
  if (sphere(x, y - 0.38, z - 0.78, 0.045) < 0.01) return hex(0x0c0c0c);                     // nose
  if (earD(x, y, z) < 0.01 && z - 0.36 > -0.02 && y > 0.55) return hex(0x2a1a14);            // dark ear fronts
  if (y < -0.3 && y > -0.62) return hex(0x2a1c16);                                           // socks
  if (z < -0.8 && y > 0.2) return mixc(hex(0xe9611a), hex(0xfff3e0), smoothstep(-0.95, -1.15, z));   // white tail tip
  if (ax < 0.12 && y > 0.0 && y < 0.3 && z > 0.15) return hex(0xfff3e0);                    // chest + muzzle
  if (ax > 0.17 && y > 0.3 && y < 0.5 && z > 0.38) return hex(0xfff3e0);                     // cheek tufts
  return mixc(hex(0xe2641b), hex(0xf4903f), smoothstep(-0.3, 0.5, y) * 0.8 + 0.2 * noise3(x * 6, y * 6, z * 6));
}
function surface(x, y, z) {
  var ax = Math.abs(x);
  if (sphere(ax - 0.12, y - 0.47, z - 0.62, 0.05) < 0) return [0.0, 0.05, 0.1];   // glossy wet eyes
  if (sphere(x, y - 0.38, z - 0.78, 0.045) < 0.01) return [0.0, 0.15, 0];          // shiny nose
  return [0.0, 0.88, 0];                                                           // soft matte fur
}
function displace(x, y, z) {                                                       // real fur-like micro-relief (skipped on the face detail)
  if (y > 0.3 && z > 0.5) return 0;
  return 0.006 * fbm(x * 42, y * 42, z * 42, 2);
}
var material = { metallic: 0.0, roughness: 0.85 };
var bounds = { min: [-0.55, -0.65, -1.4], max: [0.55, 0.85, 0.95] };`;

export const FORGE_EXAMPLE_SWORD = `// HERO SWORD (hard surface). Blade points +y, flat faces look along +z. Total height ~2.3, centred on the origin.
function blade(x, y, z) {
  var w = mix(0.118, 0.105, clamp((y - 0.02) / 0.76, 0, 1));    // straight blade, slight taper
  var th = 0.016 + 0.02 * (1 - Math.min(1, Math.abs(x) / w));    // diamond cross-section: thick spine, thin edges (never below 0.016)
  var d = Math.max((Math.abs(x) - w) * 0.88, (Math.abs(z) - th) * 0.9);
  if (y > 0.78) d = Math.max(d, Math.max(Math.hypot(x - 0.395, y - 0.78) - 0.5, Math.hypot(x + 0.395, y - 0.78) - 0.5)); // ogive point from two big circles
  return Math.max(d, -(y - 0.02));
}
function guard(x, y, z) {
  var ax = Math.abs(x);
  var bar = curveTube(ax, y, z, 0, -0.01, 0, 0.24, -0.03, 0, 0.47, 0.08, 0, 0.05, 0.03);   // swept, upturned quillons
  var knob = sphere(ax - 0.49, y - 0.095, z, 0.048);
  var collar = roundCylinder(x, y - 0.0, z, 0.075, 0.04, 0.012);
  return smin(smin(bar, knob, 0.02), collar, 0.02);
}
function grip(x, y, z) { return cappedCone(x, y + 0.36, z, 0.3, 0.052, 0.042); }
function pommel(x, y, z) { return smin(sphere(x, y + 0.7, z, 0.088), roundCylinder(x, y + 0.63, z, 0.05, 0.03, 0.01), 0.03); }
function gem(x, y, z) { return octahedron(x, y - 0.02, z - 0.055, 0.062); }
function sdf(x, y, z) {
  var d = union(blade(x, y, z), union(guard(x, y, z), union(grip(x, y, z), pommel(x, y, z))));
  return union(d, gem(x, y, z));
}
function color(x, y, z) {
  if (gem(x, y, z) < 0.012) return hex(0xff1f4d);                                  // ruby
  if (blade(x, y, z) < 0.012) return mixc(hex(0xe9eef4), hex(0xa9bfd6), smoothstep(0.2, 1.1, y)); // steel, bluer toward the tip
  if (grip(x, y, z) < 0.012) return mixc(hex(0x2e1b12), hex(0x4a2c1b), 0.5 + 0.5 * noise3(x * 30, y * 30, z * 30)); // leather
  return mixc(hex(0xc99532), hex(0xf2cf6b), smoothstep(-0.05, 0.12, y));            // gold
}
function surface(x, y, z) {                                                          // [metallic, roughness, emissive]
  if (gem(x, y, z) < 0.012) return [0.0, 0.08, 1.3];
  if (blade(x, y, z) < 0.012) return [1.0, 0.16, 0];
  if (grip(x, y, z) < 0.012) return [0.0, 0.85, 0];
  return [1.0, 0.28, 0];
}
function displace(x, y, z) {
  if (y > 0.14 && y < 0.92 && Math.abs(x) < 0.034) return -0.012 * smoothstep(0.034, 0.012, Math.abs(x)) * smoothstep(0.14, 0.22, y) * smoothstep(0.92, 0.84, y); // fuller groove, eased at both ends
  if (y > -0.64 && y < -0.07 && Math.sqrt(x * x + z * z) < 0.06) return -0.005 * ridge(y + Math.atan2(z, x) * 0.05, 0.06, 0.011); // wrapped grip
  return 0;
}
var material = { metallic: 0.8, roughness: 0.3 };
var bounds = { min: [-0.6, -0.85, -0.14], max: [0.6, 1.2, 0.14] };`;

export const FORGE_EXAMPLE_QUEEN = `// CHESS QUEEN (lathe profile + radial repeat). y is up. Total height ~2.4, centred on the origin.
function rad(y) {                                    // body radius at height y, sampled smoothly with ramp()
  var t = clamp((y + 1.2) / 1.9, 0, 1);               // 0 at the base, 1 at the neck
  return ramp(t, 0.66, 0.66, 0.52, 0.34, 0.24, 0.17, 0.14, 0.15, 0.2, 0.3, 0.32, 0.24);
}
function body(x, y, z) {
  var d = lathe(x, y, z, rad(y));
  return Math.max(d, Math.max(y - 0.75, -1.2 - y));  // cap the top and the bottom
}
function rings(x, y, z) {
  return Math.min(torus(x, y + 1.1, z, 0.6, 0.05), Math.min(torus(x, y + 0.62, z, 0.3, 0.04), torus(x, y - 0.38, z, 0.17, 0.035)));
}
function crown(x, y, z) {
  var u = polarU(x, z, 9), v = polarV(x, z, 9);       // fold space into 9 identical sectors
  var spike = cappedCone(u - 0.3, y - 0.98, v, 0.22, 0.05, 0.024);
  var pearl = sphere(u - 0.3, y - 1.19, v, 0.055);
  var orb = sphere(x, y - 0.9, z, 0.12);
  var bowl = cylinder(x, y - 0.77, z, 0.34, 0.06);          // overlaps the neck by 0.04 so crown and body are one piece
  return smin(smin(spike, pearl, 0.02), smin(orb, bowl, 0.04), 0.03);
}
function sdf(x, y, z) {
  var d = smin(body(x, y, z), rings(x, y, z), 0.03);
  return smin(d, crown(x, y, z), 0.025);
}
function isGold(x, y, z) { return rings(x, y, z) < 0.012 || crown(x, y, z) < 0.012; }
function color(x, y, z) {
  if (isGold(x, y, z)) return mixc(hex(0xc9942d), hex(0xf6d878), 0.5 + 0.5 * noise3(x * 8, y * 8, z * 8));
  if (y < -1.12) return hex(0x1b3a2b);                                                    // green felt base
  var vein = Math.abs(fbm(x * 3 + y * 1.5, y * 3, z * 3, 3));                              // marble veining
  return mixc(hex(0xf3ead8), hex(0xb9a98c), smoothstep(0.0, 0.16, 0.16 - vein) * 0.55);
}
function surface(x, y, z) {
  if (isGold(x, y, z)) return [1.0, 0.25, 0];
  if (y < -1.12) return [0.0, 0.95, 0];
  return [0.0, 0.18, 0];                                                                    // polished marble
}
function displace(x, y, z) {                                                                // fine ribbing on the base moulding
  if (y < -0.95 && y > -1.15) return -0.006 * ridge(Math.atan2(z, x) * 0.1, 0.012, 0.0035);
  return 0;
}
var material = { metallic: 0.0, roughness: 0.3 };
var bounds = { min: [-0.72, -1.25, -0.72], max: [0.72, 1.35, 0.72] };`;

const FENCE = "```";

export const FORGE_PROMPT = `MODEL MODE - ZEROS PARTICLE FORGE v2. You are a world-class technical artist and character/prop modeler who builds production-quality 3D models as code.
Your program describes a solid as a signed-distance field (SDF) plus per-point colour, PBR material and micro-detail. Zeros then samples your field with millions of particles, fuses them into ONE watertight, pure-quad, evenly-tessellated mesh, snaps hard edges crisp, refines the topology 4x, carves your micro-detail into REAL geometry, and exports a PBR GLB (+ OBJ / PLY / STL). The better your program, the more it looks like a professional sculpted asset - so spend your effort on forms, details and materials.

PROTOCOL. The user message may start with a tag. Obey it exactly:
[[PLAN]]   -> reply with ONE JSON object only (no fences, no prose): the build plan
  {"subject":string,"style":string,"silhouette":string,"heightToWidth":number,
   "parts":[{"name":string,"primitive":string,"size":string,"position":string,"blend":"union|smin 0.1|ssub|..."}],
   "materials":[{"region":string,"color":"#hex","metallic":number,"roughness":number,"emissive":number}],
   "microDetail":[string,...],"risks":[string,...]}
  List 14-40 parts (big masses first, then secondary forms, then fine details), true-to-life proportions with numbers, and 4-8 distinct materials. "risks" = what could go wrong (thin tips, floating parts) and how you avoid it.
[[REPAIR]] -> the message lists problems; return the COMPLETE corrected program in one js block (never a diff). Keep everything that works.
No tag / [[BUILD]] -> ONE witty line (max 24 words, 1-2 emoji, specific to what you build), then exactly one ${FENCE}js block. Nothing after the block. If a PLAN is included in the message, follow it faithfully.

THE PROGRAM runs in a sandbox with this toolkit (plain numbers, no imports). y is up. Every shape function returns a signed distance: negative inside, positive outside.
 Primitives: sphere(x,y,z,r) box(x,y,z,hx,hy,hz) roundBox(x,y,z,hx,hy,hz,r) cylinder(x,y,z,r,halfH) [axis y] roundCylinder(x,y,z,r,halfH,k)
  capsule(x,y,z, ax,ay,az, bx,by,bz, r) taperedCapsule(x,y,z, ax,ay,az,ra, bx,by,bz,rb) torus(x,y,z,R,r) [ring around y] cone(x,y,z,r,halfH) [apex +y]
  cappedCone(x,y,z,halfH,rBottom,rTop) [axis y, exact] roundCone(x,y,z,r1,r2,h) [sphere r1 at origin, sphere r2 at (0,h,0)] hexPrism(x,y,z,r,halfH)
  octahedron(x,y,z,s) pyramid(x,y,z,halfBase,h) [base at y=0, apex y=h] ellipsoid(x,y,z,rx,ry,rz) plane(y,h)
  curveTube(x,y,z, ax,ay,az, bx,by,bz, cx,cy,cz, r0,r1) [Bezier tube A->B->C, radius r0->r1: tails, horns, cables, tentacles, handles]
  lathe(x,y,z,r) [solid of revolution - pass the profile radius for this height, e.g. lathe(x,y,z, ramp((y+1)/2, .5,.3,.2,.4))]
 Combine: union(a,b) subtract(a,b) [a minus b] intersect(a,b) smin(a,b,k) [smooth union] smax(a,b,k) ssub(a,b,k) [smooth subtract] sint(a,b,k) onion(d,t) [hollow shell]
 Move by changing coordinates BEFORE the primitive: translate = box(x-0.3, y+0.1, z, ...); mirror = use Math.abs(x); rotate = u = rot2u(a, x, y), v = rot2v(a, x, y) (any axis pair);
  repeat on a line = x - step*Math.round(x/step); RADIAL repeat (gears, petals, spokes, columns) = u = polarU(x,z,N), v = polarV(x,z,N) then use u,v instead of x,z.
 Shaping helpers: ramp(t01, v0, v1, v2, ...) smooth interpolation through control values (profiles, tapers) | ridge(v, period, width) periodic 0..1 lines (grooves, ribs, wraps)
 Texture maths: noise3(x,y,z) in [-1,1], fbm(x,y,z,octaves), cells3(x,y,z) [Voronoi distance: scales, cobbles, cracks, hammered metal], hash3, clamp, mix, smoothstep, fract, PI, TAU.
 Colour: function color(x,y,z) -> [r,g,b] in 0..1: hex(0xRRGGBB), rgb(r,g,b), hsl(h,s,l), mixc(c1,c2,t), lighten(c,t), darken(c,t).
 OPTIONAL BUT EXPECTED (this is what makes a model look premium):
  function surface(x,y,z) -> [metallic, roughness, emissive]  per-region PBR: chrome [1,0.15,0], gold [1,0.3,0], wood/leather/fabric [0,0.8,0], plastic [0,0.45,0], glossy paint [0.6,0.2,0], glass-like [0,0.04,0], skin [0,0.55,0], glowing lights/gems/screens [0,0.1, 1.0-2.0].
  function displace(x,y,z) -> number: micro-relief carved into the REAL mesh along the surface normal (units, typically -0.012..+0.012): fur, scales, pores, hammered metal, wood grain, stitching, grips, treads, panel seams, rivets, engravings, stone cracks.
  var material = { metallic, roughness } (fallback) ; var bounds = { min:[x,y,z], max:[x,y,z] } (generous box around the model).

HOW A MASTER MODELER WORKS (do this silently, then write the code)
1. Identify the subject's iconic silhouette and true proportions (number them). 2. Block big masses first, join with smin (organic 0.06-0.25) or union (hard seams). 3. Add secondary forms: panels, trims, eyes, ears, handles, steps, buttons, hinges - 12-30 of them. 4. Add tertiary detail with displace(): the surface must never look like smooth plastic unless the subject is plastic. 5. Colour by region (3-7 colours), then give EVERY region a real surface() material. 6. Break perfect symmetry slightly for life; keep it believable.

HARD RULES (each one was learned from a real failure)
1. Define function sdf(x, y, z) returning a finite number. ONE connected solid: parts that merely TOUCH become separate floating pieces, so overlap every joint by at least 0.03 or blend it with smin - axles reach into hubs, crowns sink into necks, gems sit inside their settings.
2. Centre on the origin, longest dimension 1.8-2.4 units (never above 2.5), feet/ground near y = -(height/2). Characters face +z, vehicles face +x.
3. THIN FEATURES VANISH: the field resolves about 0.008-0.012 units. Keep every solid feature >= 0.03 thick (blade edges >= 0.016 half-thickness, no zero-width tapers: end points at >= 0.03 radius or round them). Whiskers, wires, hairs and paper-thin fins must be thickened to >= 0.03 - or leave them out. Surface detail belongs in displace(), not in sdf().
4. sdf is called millions of times: no arrays, objects or closures created inside sdf, loops <= 12 iterations, reuse sub-results. Up to ~60 primitives is fine. color/surface/displace run once per vertex: they may call the same shape helpers to find which part they are on (use dist < 0.012 as "on this part").
5. For hard-surface models use union and tiny smin (0.01-0.03) so edges stay crisp - Zeros snaps vertices onto sharp edges automatically. Large smin radii round everything into a toy.
6. displace amplitude: 0.003-0.012. Use smoothstep ramps so a groove never starts or stops abruptly. Never displace eyes, gems or glass.
7. Pure maths only: no DOM, no async, no Math.random (use hash3), no imports. Short comments welcome.
8. Match the request exactly (subject, style, colours, details); invent tasteful specifics rather than staying generic. Stylised + detailed beats lumpy-realistic.

DETAIL RECIPES
- fur: displace = 0.005*fbm(x*42,y*42,z*42,2) | scales: 0.006*(0.5 - cells3(x*18,y*18,z*18)) | hammered metal: -0.004*smoothstep(0.1,0.5,cells3(x*14,y*14,z*14)) | wood grain: 0.003*ridge(x + 0.3*noise3(x*2,y*2,z*2), 0.05, 0.012)
- screw/rivet heads: tiny spheres unioned (r 0.02) | panel seams: -0.006 where abs(x - seam) < 0.008 | wrapped grip: -0.005*ridge(y + atan2(z,x)*0.05, 0.06, 0.011) | tyre tread / ribbing: ridge on the angle
- gems/screens/lights/eyes: surface returns emissive 1.0-2.0 | glass: roughness 0.04 and a dark tinted colour | polished metal: metallic 1.0, roughness 0.15-0.3

EXAMPLE 1 - hard-surface vehicle (radial spokes, tread, emissive lights):
${FENCE}js
${FORGE_EXAMPLE_CAR}
${FENCE}

EXAMPLE 2 - organic character (fur relief, glossy eyes, Bezier tail):
${FENCE}js
${FORGE_EXAMPLE_FOX}
${FENCE}

EXAMPLE 3 - hero prop (thin blade, crisp bevels, four materials, emissive gem):
${FENCE}js
${FORGE_EXAMPLE_SWORD}
${FENCE}

EXAMPLE 4 - revolve + radial repeat (lathe profile, 9-fold crown, marble + gold):
${FENCE}js
${FORGE_EXAMPLE_QUEEN}
${FENCE}`;

/** First js/javascript code block, or the program text if the reply is bare code. */
export function extractForgeCode(text: string): string | null {
  const m = text.match(/```(?:js|javascript|ts|typescript)?[ \t]*\r?\n([\s\S]*?)(?:```|$)/i);
  const code = (m?.[1] ?? "").trim();
  if (code.includes("function sdf") || /\bsdf\s*=/.test(code)) return code;
  return text.includes("function sdf") ? text.slice(text.indexOf("function sdf")).trim() : null;
}

export function forgeWitty(text: string): string {
  const before = text.split("```")[0] ?? "";
  return before.replace(/\s+/g, " ").trim().slice(0, 220);
}

export type ForgePlan = {
  subject?: string; style?: string; silhouette?: string; heightToWidth?: number;
  parts?: { name?: string; primitive?: string; size?: string; position?: string; blend?: string }[];
  materials?: { region?: string; color?: string; metallic?: number; roughness?: number; emissive?: number }[];
  microDetail?: string[]; risks?: string[];
};

/** Tolerant JSON extraction for the [[PLAN]] reply (fences, prose and trailing commas are tolerated). */
export function parseForgePlan(text: string): ForgePlan | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const raw = text.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
  try {
    const j = JSON.parse(raw) as unknown;
    return j && typeof j === "object" ? (j as ForgePlan) : null;
  } catch {
    return null;
  }
}

/** Compact, prompt-friendly rendering of a plan. */
export function planToText(plan: ForgePlan): string {
  const parts = (plan.parts ?? []).slice(0, 48).map((p) => `- ${p.name ?? "part"}: ${[p.primitive, p.size, p.position, p.blend].filter(Boolean).join(" | ")}`).join("\n");
  const mats = (plan.materials ?? []).slice(0, 10).map((m) => `- ${m.region ?? "region"}: ${m.color ?? ""} metal ${m.metallic ?? 0} rough ${m.roughness ?? 0.5}${m.emissive ? ` emissive ${m.emissive}` : ""}`).join("\n");
  const det = (plan.microDetail ?? []).slice(0, 10).map((d) => `- ${d}`).join("\n");
  const risks = (plan.risks ?? []).slice(0, 6).map((d) => `- ${d}`).join("\n");
  return [`SUBJECT: ${plan.subject ?? ""} (${plan.style ?? "stylised"})`, `SILHOUETTE: ${plan.silhouette ?? ""}`, `PARTS:\n${parts}`, `MATERIALS:\n${mats}`, `MICRO-DETAIL (displace):\n${det}`, `RISKS:\n${risks}`].join("\n");
}
