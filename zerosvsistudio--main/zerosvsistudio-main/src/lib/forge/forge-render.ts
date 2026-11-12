import { triangulate } from "./forge-export";
import type { ForgeMesh } from "./forge-client";

type Vec3 = [number, number, number];
export type ViewMode = "particles" | "mesh" | "clay" | "wire";
export type RenderState = { yaw: number; pitch: number; dist: number; mode: ViewMode; assemble: number; time: number; meshMix: number };

const MESH_VS = `#version 300 es
precision highp float;
in vec3 aPos; in vec3 aNor; in vec3 aCol; in vec3 aMat;
uniform mat4 uVP;
out vec3 vPos; out vec3 vNor; out vec3 vCol; out vec3 vMat;
void main(){ vPos=aPos; vNor=aNor; vCol=aCol; vMat=aMat; gl_Position=uVP*vec4(aPos,1.0); }`;

/* Studio-lit metal/rough PBR: GGX highlights, Fresnel, a procedural softbox environment, hemispheric bounce. */
const MESH_FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNor; in vec3 vCol; in vec3 vMat;
uniform vec3 uCam; uniform float uAlpha; uniform float uWire; uniform float uClay; uniform float uMetal; uniform float uRough;
out vec4 o;
const float PI=3.14159265;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
float ggx(float nh,float r){ float a=r*r; float a2=a*a; float d=nh*nh*(a2-1.0)+1.0; return a2/(PI*d*d+1e-5); }
float smithG(float nv,float nl,float r){ float k=(r+1.0)*(r+1.0)/8.0; return (nv/(nv*(1.0-k)+k))*(nl/(nl*(1.0-k)+k)); }
vec3 envLight(vec3 d,float rough){
  float up=d.y*0.5+0.5;
  vec3 sky=mix(vec3(0.07,0.065,0.08),vec3(0.56,0.66,0.88),smoothstep(0.15,1.0,up));
  vec3 horizon=vec3(0.30,0.30,0.34)*exp(-pow((up-0.5)*5.0,2.0));
  vec3 k1=normalize(vec3(-0.45,0.85,0.55)), k2=normalize(vec3(0.85,0.30,0.30)), k3=normalize(vec3(0.15,0.40,-0.9));
  float sharp=mix(90.0,3.0,rough);
  vec3 boxes=vec3(1.0,0.93,0.82)*pow(max(dot(d,k1),0.0),sharp)*2.4+vec3(0.55,0.68,1.0)*pow(max(dot(d,k2),0.0),sharp)*1.1+vec3(0.8,0.85,1.0)*pow(max(dot(d,k3),0.0),sharp)*1.3;
  vec3 e=sky+horizon+boxes;
  return mix(e,vec3(0.30,0.33,0.40),rough*rough*0.55);
}
void main(){
  vec3 N=normalize(vNor); vec3 V=normalize(uCam-vPos);
  if(dot(N,V)<0.0) N=-N;
  if(uWire>0.5){ o=vec4(vec3(0.55,0.85,1.0)*0.95,uAlpha); return; }
  bool hasMat = (vMat.x+vMat.y+vMat.z)>0.001;
  float metal = uClay>0.5 ? 0.0 : (hasMat ? vMat.x : uMetal);
  float rough = clamp(uClay>0.5 ? 0.62 : (hasMat ? vMat.y : uRough),0.06,1.0);
  float emis  = uClay>0.5 ? 0.0 : vMat.z*2.0;
  vec3 albedo = uClay>0.5 ? vec3(0.60,0.58,0.56) : pow(vCol,vec3(2.2));
  vec3 F0=mix(vec3(0.04),albedo,metal);
  float nv=max(dot(N,V),1e-3);
  vec3 L1=normalize(vec3(-0.45,0.85,0.55)), L2=normalize(vec3(0.85,0.30,0.30)), L3=normalize(vec3(0.15,0.40,-0.9));
  vec3 C1=vec3(1.0,0.95,0.86)*3.0, C2=vec3(0.55,0.68,1.0)*0.9, C3=vec3(0.85,0.9,1.0)*1.5;
  vec3 spec=vec3(0.0), diff=vec3(0.0);
  for(int i=0;i<3;i++){
    vec3 L = i==0?L1:(i==1?L2:L3); vec3 C = i==0?C1:(i==1?C2:C3);
    float nl=max(dot(N,L),0.0); vec3 H=normalize(L+V); float nh=max(dot(N,H),0.0), vh=max(dot(V,H),0.0);
    vec3 F=F0+(1.0-F0)*pow(1.0-vh,5.0);
    spec+=C*nl*F*ggx(nh,rough)*smithG(nv,nl,rough)/(4.0*nv*max(nl,1e-3)+1e-4);
    diff+=C*nl;
  }
  vec3 irr=mix(vec3(0.05,0.045,0.05),vec3(0.32,0.38,0.50),N.y*0.5+0.5);
  vec3 kD=(1.0-metal)*albedo;
  vec3 R=reflect(-V,N);
  vec3 Fr=F0+(max(vec3(1.0-rough),F0)-F0)*pow(1.0-nv,5.0);
  vec3 envR=envLight(R,rough);
  float horizon=mix(0.35,1.0,smoothstep(-0.5,0.2,R.y));     /* reflections that point at the floor are dimmed */
  float occ=mix(0.55,1.0,smoothstep(-0.9,0.7,N.y));
  vec3 col=kD*(irr*occ+diff/PI)+spec*0.5+envR*Fr*(0.55+0.45*occ)*horizon+albedo*emis;
  o=vec4(pow(aces(col*1.08),vec3(1.0/2.2)),uAlpha);
}`;

const PTS_VS = `#version 300 es
precision highp float;
precision highp int;
in vec3 aPos; in vec3 aCol;
uniform mat4 uVP; uniform float uAssemble; uniform float uTime; uniform float uSize; uniform float uCenterY; uniform float uRadius;
out vec3 vCol; out float vT;
uint pcg(uint v){ uint st=v*747796405u+2891336453u; uint w=((st>>((st>>28u)+4u))^st)*277803737u; return (w>>22u)^w; }
float h1(uint id,uint salt){ return float(pcg(id*2654435761u+salt))/4294967295.0; }
void main(){
  uint id=uint(gl_VertexID);
  vec3 dir=normalize(vec3(h1(id,1u)-0.5,h1(id,2u)-0.5,h1(id,3u)-0.5)+vec3(0.0001));
  float rad=uRadius*(0.45+1.0*h1(id,4u));
  float ang=uTime*0.5+h1(id,5u)*6.283;
  vec3 start=dir*rad+vec3(cos(ang)*0.25*uRadius,uCenterY,sin(ang)*0.25*uRadius);
  float delay=h1(id,6u)*0.5;
  float t=clamp((uAssemble-delay)/0.5,0.0,1.0); t=t*t*(3.0-2.0*t);
  vec3 p=mix(start,aPos,t);
  p+=(1.0-t)*0.04*uRadius*vec3(sin(uTime*2.0+float(id&1023u)),cos(uTime*1.7+float(id&511u)*1.3),sin(uTime*2.3+float(id&255u)*0.7));
  vec4 c=uVP*vec4(p,1.0);
  gl_Position=c;
  gl_PointSize=clamp(uSize/max(c.w,0.1)*(1.0-0.5*(1.0-t)),1.0,12.0);
  vCol=aCol; vT=t;
}`;

const PTS_FS = `#version 300 es
precision highp float;
in vec3 vCol; in float vT;
uniform float uAlpha;
out vec4 o;
void main(){
  vec2 q=gl_PointCoord*2.0-1.0; float d=dot(q,q); if(d>1.0) discard;
  vec3 base=pow(vCol,vec3(2.2));
  vec3 col=base*(0.75+0.55*(1.0-d))*(1.0+0.9*(1.0-vT))+vec3(0.18,0.25,0.4)*(1.0-vT);
  o=vec4(pow(col,vec3(1.0/2.2)),uAlpha*(0.35+0.65*smoothstep(1.0,0.2,d)));
}`;

const GROUND_VS = `#version 300 es
precision highp float;
in vec2 aXZ; uniform mat4 uVP; uniform float uY; uniform float uR; out vec2 vP;
void main(){ vP=aXZ; gl_Position=uVP*vec4(aXZ.x*uR,uY,aXZ.y*uR,1.0); }`;
const GROUND_FS = `#version 300 es
precision highp float;
in vec2 vP; uniform float uAlpha; out vec4 o;
void main(){
  float d=length(vP);
  float a=smoothstep(1.0,0.0,d); a=a*a;
  float ring=smoothstep(0.012,0.0,abs(d-0.82))*0.35+smoothstep(0.01,0.0,abs(d-0.5))*0.15;
  float contact=smoothstep(0.42,0.0,d);           /* soft contact shadow under the model */
  vec3 glow=vec3(0.35,0.6,1.0)*ring;
  float alpha=(a*0.42+ring+contact*0.55)*uAlpha;
  o=vec4(glow*(1.0-contact*0.8),alpha);
}`;

function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
}
function mat4LookAt(eye: Vec3, c: Vec3, up: Vec3): Float32Array {
  let zx = eye[0] - c[0], zy = eye[1] - c[1], zz = eye[2] - c[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[4] = xy; m[5] = yy; m[6] = zy; m[8] = xz; m[9] = yz; m[10] = zz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]); m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]); m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]); m[15] = 1;
  return m;
}
function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
  return o;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Shader error: " + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!; gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Link error: " + gl.getProgramInfoLog(p));
  return p;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

export class ForgeRenderer {
  readonly gl: WebGL2RenderingContext;
  private progMesh!: WebGLProgram; private progPts!: WebGLProgram; private progGround!: WebGLProgram;
  private uMesh: Uniforms = {}; private uPts: Uniforms = {}; private uGround: Uniforms = {};
  private vaoTri: WebGLVertexArrayObject | null = null; private vaoLines: WebGLVertexArrayObject | null = null; private vaoPts: WebGLVertexArrayObject | null = null; private vaoGround: WebGLVertexArrayObject | null = null;
  private meshBufs: WebGLBuffer[] = []; private groundBuf: WebGLBuffer | null = null;
  private triCount = 0; private lineCount = 0; private pointCount = 0;
  private lost = false; private lastMesh: ForgeMesh | null = null;
  center: Vec3 = [0, 0, 0]; radius = 1; floorY = -1; pointWorld = 0.01; private material = { metallic: 0.15, roughness: 0.55 }; private centerY = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.initGl();
    canvas.addEventListener("webglcontextlost", this.onLost, false);
    canvas.addEventListener("webglcontextrestored", this.onRestored, false);
  }

  private onLost = (e: Event) => { e.preventDefault(); this.lost = true; };
  private onRestored = () => {
    this.lost = false; this.meshBufs = []; this.vaoTri = this.vaoLines = this.vaoPts = null; this.groundBuf = null;
    try { this.initGl(); if (this.lastMesh) this.setMesh(this.lastMesh); } catch { /* the next render will simply draw nothing */ }
  };

  private loc(prog: WebGLProgram, names: string[]): Uniforms {
    const out: Uniforms = {};
    for (const n of names) out[n] = this.gl.getUniformLocation(prog, n);
    return out;
  }

  private initGl(): void {
    const gl = this.gl;
    this.progMesh = program(gl, MESH_VS, MESH_FS); this.progPts = program(gl, PTS_VS, PTS_FS); this.progGround = program(gl, GROUND_VS, GROUND_FS);
    this.uMesh = this.loc(this.progMesh, ["uVP", "uCam", "uAlpha", "uWire", "uClay", "uMetal", "uRough"]);
    this.uPts = this.loc(this.progPts, ["uVP", "uAssemble", "uTime", "uSize", "uCenterY", "uRadius", "uAlpha"]);
    this.uGround = this.loc(this.progGround, ["uVP", "uY", "uR", "uAlpha"]);
    this.vaoGround = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoGround);
    this.groundBuf = gl.createBuffer()!;
    const seg = 64, fan = new Float32Array((seg + 2) * 2); fan[0] = 0; fan[1] = 0;
    for (let i = 0; i <= seg; i++) { fan[(i + 1) * 2] = Math.cos((i / seg) * Math.PI * 2); fan[(i + 1) * 2 + 1] = Math.sin((i / seg) * Math.PI * 2); }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf); gl.bufferData(gl.ARRAY_BUFFER, fan, gl.STATIC_DRAW);
    const l = gl.getAttribLocation(this.progGround, "aXZ"); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private buf(target: number, data: ArrayBufferView): WebGLBuffer {
    const gl = this.gl, b = gl.createBuffer()!; this.meshBufs.push(b);
    gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b;
  }

  private freeMesh(): void {
    const gl = this.gl;
    for (const b of this.meshBufs) gl.deleteBuffer(b);
    this.meshBufs = [];
    if (this.vaoTri) gl.deleteVertexArray(this.vaoTri);
    if (this.vaoLines) gl.deleteVertexArray(this.vaoLines);
    if (this.vaoPts) gl.deleteVertexArray(this.vaoPts);
    this.vaoTri = this.vaoLines = this.vaoPts = null;
  }

  setMesh(m: ForgeMesh): void {
    const gl = this.gl;
    this.lastMesh = m;
    this.freeMesh();
    this.material = m.material;
    const b = m.stats.bounds;
    this.center = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    this.radius = Math.max(0.2, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
    this.floorY = b.min[1] - this.radius * 0.02; this.centerY = this.center[1];
    this.pointWorld = Math.sqrt(Math.max(1e-6, m.stats.surfaceArea || this.radius * this.radius * 4) / Math.max(1, m.points.length / 3)) * 0.95;

    const tri = triangulate(m);
    const pBuf = this.buf(gl.ARRAY_BUFFER, m.positions), nBuf = this.buf(gl.ARRAY_BUFFER, m.normals), cBuf = this.buf(gl.ARRAY_BUFFER, m.colors), mBuf = this.buf(gl.ARRAY_BUFFER, m.mats);
    const attribs = () => {
      const at = (name: string, buf: WebGLBuffer, size: number, type: number, norm: boolean) => {
        const l = gl.getAttribLocation(this.progMesh, name); if (l < 0) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, type, norm, 0, 0);
      };
      at("aPos", pBuf, 3, gl.FLOAT, false); at("aNor", nBuf, 3, gl.FLOAT, false); at("aCol", cBuf, 3, gl.UNSIGNED_BYTE, true); at("aMat", mBuf, 3, gl.UNSIGNED_BYTE, true);
    };

    this.vaoTri = gl.createVertexArray()!; gl.bindVertexArray(this.vaoTri); attribs();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf(gl.ELEMENT_ARRAY_BUFFER, tri)); this.triCount = tri.length;
    gl.bindVertexArray(null);

    /* wireframe = the real quad topology; each interior edge once (emit it from the quad where a < b) */
    const q = m.quads, nQ = q.length / 4, edges: number[] = [];
    for (let i = 0; i < nQ; i++) for (let e = 0; e < 4; e++) {
      const a = q[i * 4 + e]!, c = q[i * 4 + ((e + 1) & 3)]!;
      if (a < c) edges.push(a, c);
    }
    const lines = new Uint32Array(edges.length); lines.set(edges); this.lineCount = lines.length;
    this.vaoLines = gl.createVertexArray()!; gl.bindVertexArray(this.vaoLines); attribs();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf(gl.ELEMENT_ARRAY_BUFFER, lines));
    gl.bindVertexArray(null);

    this.vaoPts = gl.createVertexArray()!; gl.bindVertexArray(this.vaoPts);
    const pl = gl.getAttribLocation(this.progPts, "aPos"), cl = gl.getAttribLocation(this.progPts, "aCol");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf(gl.ARRAY_BUFFER, m.points)); if (pl >= 0) { gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 3, gl.FLOAT, false, 0, 0); }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf(gl.ARRAY_BUFFER, m.pointColors)); if (cl >= 0) { gl.enableVertexAttribArray(cl); gl.vertexAttribPointer(cl, 3, gl.UNSIGNED_BYTE, true, 0, 0); }
    this.pointCount = m.points.length / 3;
    gl.bindVertexArray(null);
  }

  resize(w: number, h: number, dpr = 1): void {
    const W = Math.max(2, Math.floor(w * dpr)), H = Math.max(2, Math.floor(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
  }

  render(s: RenderState): void {
    if (this.lost) return;
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.vaoTri) return;
    const fov = (36 * Math.PI) / 180, dist = this.radius * s.dist;
    const cp = Math.cos(s.pitch), eye: Vec3 = [this.center[0] + dist * cp * Math.sin(s.yaw), this.center[1] + dist * Math.sin(s.pitch), this.center[2] + dist * cp * Math.cos(s.yaw)];
    const vp = mat4Mul(mat4Perspective(fov, W / H, this.radius * 0.05, this.radius * 40), mat4LookAt(eye, this.center, [0, 1, 0]));
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);

    gl.useProgram(this.progGround); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
    gl.uniformMatrix4fv(this.uGround["uVP"]!, false, vp);
    gl.uniform1f(this.uGround["uY"]!, this.floorY); gl.uniform1f(this.uGround["uR"]!, this.radius * 1.9); gl.uniform1f(this.uGround["uAlpha"]!, 1);
    gl.bindVertexArray(this.vaoGround); gl.drawArrays(gl.TRIANGLE_FAN, 0, 66); gl.depthMask(true);

    const meshDraw = (alpha: number, wire: boolean, clay: boolean) => {
      gl.useProgram(this.progMesh);
      gl.uniformMatrix4fv(this.uMesh["uVP"]!, false, vp);
      gl.uniform3fv(this.uMesh["uCam"]!, eye);
      gl.uniform1f(this.uMesh["uMetal"]!, this.material.metallic); gl.uniform1f(this.uMesh["uRough"]!, this.material.roughness);
      gl.uniform1f(this.uMesh["uAlpha"]!, alpha); gl.uniform1f(this.uMesh["uWire"]!, wire ? 1 : 0); gl.uniform1f(this.uMesh["uClay"]!, clay ? 1 : 0);
      if (wire) { gl.bindVertexArray(this.vaoLines); gl.drawElements(gl.LINES, this.lineCount, gl.UNSIGNED_INT, 0); }
      else { gl.bindVertexArray(this.vaoTri); gl.drawElements(gl.TRIANGLES, this.triCount, gl.UNSIGNED_INT, 0); }
    };
    const ptsDraw = (alpha: number) => {
      gl.useProgram(this.progPts);
      gl.uniformMatrix4fv(this.uPts["uVP"]!, false, vp);
      gl.uniform1f(this.uPts["uAssemble"]!, s.assemble); gl.uniform1f(this.uPts["uTime"]!, s.time);
      gl.uniform1f(this.uPts["uCenterY"]!, this.centerY); gl.uniform1f(this.uPts["uRadius"]!, this.radius); gl.uniform1f(this.uPts["uAlpha"]!, alpha);
      gl.uniform1f(this.uPts["uSize"]!, (this.pointWorld * H) / (2 * Math.tan(fov / 2)) * 1.25);
      gl.bindVertexArray(this.vaoPts); gl.drawArrays(gl.POINTS, 0, this.pointCount);
    };

    if (s.mode === "mesh") { gl.disable(gl.BLEND); meshDraw(1, false, false); }
    else if (s.mode === "clay") { gl.disable(gl.BLEND); meshDraw(1, false, true); }
    else if (s.mode === "wire") { gl.disable(gl.BLEND); meshDraw(1, false, false); gl.enable(gl.BLEND); gl.depthFunc(gl.LEQUAL); meshDraw(0.5, true, false); }
    else {
      gl.enable(gl.BLEND);
      if (s.meshMix > 0) { gl.disable(gl.BLEND); meshDraw(1, false, false); gl.enable(gl.BLEND); }
      if (s.meshMix < 1) ptsDraw(1 - s.meshMix);
    }
    gl.bindVertexArray(null);
  }

  /** Renders one still (JPEG data URL) of the solid mesh from a given angle. */
  capture(yaw: number, pitch: number, size = 480, clay = false): string {
    this.canvas.width = size; this.canvas.height = size;
    this.render({ yaw, pitch, dist: 3.5, mode: clay ? "clay" : "mesh", assemble: 1, time: 0, meshMix: 1 });
    const c = document.createElement("canvas"); c.width = size; c.height = size;
    const ctx = c.getContext("2d")!; ctx.fillStyle = "#14161d"; ctx.fillRect(0, 0, size, size); ctx.drawImage(this.canvas, 0, 0);
    return c.toDataURL("image/jpeg", 0.88);
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.freeMesh();
    if (this.groundBuf) this.gl.deleteBuffer(this.groundBuf);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
