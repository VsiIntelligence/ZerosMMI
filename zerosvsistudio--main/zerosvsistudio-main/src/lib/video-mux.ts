/**
 * Minimal WebM (Matroska) muxer for WebCodecs output: VP8/VP9/AV1 video + Opus audio, with SeekHead + Cues so the file is seekable.
 * All chunks are held in memory and written once, so every element size and offset is exact.
 */
export type MuxVideoConfig = { codec: "V_VP8" | "V_VP9" | "V_AV1"; width: number; height: number; fps: number; codecPrivate?: Uint8Array };
export type MuxAudioConfig = { sampleRate: number; channels: number; preSkip?: number };
type Chunk = { track: 1 | 2; timeMs: number; key: boolean; data: Uint8Array };

class Bytes {
  private parts: Uint8Array[] = [];
  length = 0;
  push(b: Uint8Array): void { this.parts.push(b); this.length += b.length; }
  concat(): Uint8Array { const out = new Uint8Array(this.length); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

const idBytes = (id: number): Uint8Array => { const b: number[] = []; let v = id; while (v > 0) { b.unshift(v & 0xff); v = Math.floor(v / 256); } return Uint8Array.from(b); };
function sizeBytes(n: number): Uint8Array {
  let len = 1; while (len < 8 && n >= Math.pow(2, 7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] = out[0]! | (1 << (8 - len));
  return out;
}
const cat = (...a: Uint8Array[]): Uint8Array => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const el = (id: number, payload: Uint8Array): Uint8Array => cat(idBytes(id), sizeBytes(payload.length), payload);
const uintEl = (id: number, v: number): Uint8Array => { let n = 1; while (n < 8 && v >= Math.pow(2, 8 * n)) n++; const b = new Uint8Array(n); let x = v; for (let i = n - 1; i >= 0; i--) { b[i] = x % 256; x = Math.floor(x / 256); } return el(id, b); };
const floatEl = (id: number, v: number): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, b); };
const strEl = (id: number, s: string): Uint8Array => el(id, new TextEncoder().encode(s));
const fixedSize = (id: number, payload: Uint8Array, bytes = 8): Uint8Array => { // fixed-width size field (used for Segment so it can be patched)
  const size = new Uint8Array(bytes); let v = payload.length; for (let i = bytes - 1; i >= 1; i--) { size[i] = v % 256; v = Math.floor(v / 256); } size[0] = 0x01; // 8-byte marker
  return cat(idBytes(id), size, payload);
};

export class WebmMuxer {
  private chunks: Chunk[] = [];
  constructor(private video: MuxVideoConfig | undefined, private audio?: MuxAudioConfig) {}

  addVideo(data: Uint8Array, timestampUs: number, key: boolean): void { this.chunks.push({ track: 1, timeMs: Math.round(timestampUs / 1000), key, data }); }
  addAudio(data: Uint8Array, timestampUs: number): void { this.chunks.push({ track: this.video ? 2 : 1, timeMs: Math.round(timestampUs / 1000), key: true, data }); }

  finalize(durationMs: number): Blob {
    const v = this.video, a = this.audio;
    const ebml = el(0x1a45dfa3, cat(uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8), strEl(0x4282, "webm"), uintEl(0x4287, 4), uintEl(0x4285, 2)));
    const info = el(0x1549a966, cat(uintEl(0x2ad7b1, 1_000_000), floatEl(0x4489, durationMs), strEl(0x4d80, "Zeros"), strEl(0x5741, v ? "Zeros Video Studio" : "Zeros Music Studio")));
    const videoEntry = v ? el(0xae, cat(
      uintEl(0xd7, 1), uintEl(0x73c5, 1), uintEl(0x83, 1), uintEl(0x9c, 0), strEl(0x86, v.codec),
      ...(v.codecPrivate ? [el(0x63a2, v.codecPrivate)] : []),
      uintEl(0x23e383, Math.round(1e9 / v.fps)),
      el(0xe0, cat(uintEl(0xb0, v.width), uintEl(0xba, v.height))),
    )) : new Uint8Array(0);
    const aNo = v ? 2 : 1;
    let audioEntry: Uint8Array = new Uint8Array(0);
    if (a) {
      const head = new Uint8Array(19); const dv = new DataView(head.buffer);
      head.set(new TextEncoder().encode("OpusHead"), 0); head[8] = 1; head[9] = a.channels; dv.setUint16(10, a.preSkip ?? 312, true); dv.setUint32(12, a.sampleRate, true); dv.setInt16(16, 0, true); head[18] = 0;
      audioEntry = el(0xae, cat(
        uintEl(0xd7, aNo), uintEl(0x73c5, aNo), uintEl(0x83, 2), uintEl(0x9c, 0), strEl(0x86, "A_OPUS"), el(0x63a2, head),
        uintEl(0x56aa, Math.round(((a.preSkip ?? 312) / 48000) * 1e9)), uintEl(0x56bb, 80_000_000),
        el(0xe1, cat(floatEl(0xb5, a.sampleRate), uintEl(0x9f, a.channels))),
      ));
    }
    const tracks = el(0x1654ae6b, cat(videoEntry, audioEntry));

    // clusters: start a new one on every video keyframe (>= 1s apart) so Cues point at clean random-access points
    const sorted = [...this.chunks].sort((x, y) => x.timeMs - y.timeMs || x.track - y.track);
    type Cl = { startMs: number; blocks: Uint8Array[] };
    const clusters: Cl[] = [];
    for (const c of sorted) {
      let cl = clusters[clusters.length - 1];
      if (!cl || (c.track === 1 && c.key && c.timeMs - cl.startMs >= 1000) || c.timeMs - cl.startMs > 30000) { cl = { startMs: c.timeMs, blocks: [] }; clusters.push(cl); }
      const rel = c.timeMs - cl.startMs;
      const hdr = new Uint8Array(4); hdr[0] = 0x80 | c.track; hdr[1] = (rel >> 8) & 0xff; hdr[2] = rel & 0xff; hdr[3] = c.key ? 0x80 : 0x00;
      cl.blocks.push(el(0xa3, cat(hdr, c.data)));
    }
    const clusterBytes = clusters.map((cl) => el(0x1f43b675, cat(uintEl(0xe7, cl.startMs), ...cl.blocks)));

    // layout: [SeekHead][Info][Tracks][Clusters...][Cues]; segment offsets are relative to the segment payload start
    const seekEntry = (id: number, pos: number): Uint8Array => { const p = new Uint8Array(4); new DataView(p.buffer).setUint32(0, pos); return el(0x4dbb, cat(el(0x53ab, idBytes(id)), el(0x53ac, p))); };
    const SEEK_SIZE = el(0x114d9b74, cat(seekEntry(0x1549a966, 0), seekEntry(0x1654ae6b, 0), seekEntry(0x1c53bb6b, 0))).length;
    const voidPad = (n: number): Uint8Array => (n >= 2 ? el(0xec, new Uint8Array(n - 2 - (n - 2 < 127 ? 0 : 1))) : new Uint8Array(0));
    void voidPad;
    const infoPos = SEEK_SIZE, tracksPos = infoPos + info.length;
    let pos = tracksPos + tracks.length;
    const clusterPos: number[] = [];
    for (const c of clusterBytes) { clusterPos.push(pos); pos += c.length; }
    const cuePoints: Uint8Array[] = [];
    clusters.forEach((cl, i) => cuePoints.push(el(0xbb, cat(uintEl(0xb3, cl.startMs), el(0xb7, cat(uintEl(0xf7, 1), uintEl(0xf1, clusterPos[i]!)))))));
    const cues = el(0x1c53bb6b, cat(...cuePoints));
    const seekHead = el(0x114d9b74, cat(seekEntry(0x1549a966, infoPos), seekEntry(0x1654ae6b, tracksPos), seekEntry(0x1c53bb6b, pos)));
    if (seekHead.length !== SEEK_SIZE) throw new Error("webm: seek head size mismatch");

    const seg = new Bytes();
    for (const b of [seekHead, info, tracks, ...clusterBytes, cues]) seg.push(b);
    const segment = fixedSize(0x18538067, seg.concat());
    return new Blob([ebml as BlobPart, segment as BlobPart], { type: v ? "video/webm" : "audio/webm" });
  }
}
