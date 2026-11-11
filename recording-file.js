// Used by offscreen.html: choosing the file type (WebM/MP4) and making sure the
// finished file has its length, so players show it and can seek.

// Video bitrate for "High": enough for the picture's size and frame rate
// (about 0.1 bit per pixel per frame), never below the preset, at most 25 Mbps.
function videoBitrate(quality, track) {
  if (!quality.adaptive || !track) return quality.videoBitsPerSecond;
  const { width = 0, height = 0, frameRate = 30 } = track.getSettings();
  const needed = Math.round(width * height * Math.min(frameRate || 30, 60) * 0.1);
  return Math.min(25_000_000, Math.max(quality.videoBitsPerSecond, needed));
}

function extForMime(mimeType) {
  if (mimeType.startsWith('video/mp4')) return 'mp4';
  if (mimeType.startsWith('audio/mp4')) return 'm4a';
  return 'webm';
}

// MediaRecorder types to try, best first, for "av"/"audio" in "webm"/"mp4".
// MP4 with AAC sound where Chrome can make it (Windows/Mac), otherwise with
// Opus sound (e.g. Chrome on Linux; its sound timing is fixed at Stop, see
// fixMp4Audio in offscreen.js).
function mimeCandidates(mode, format) {
  // VP8 before VP9: VP9 is too slow to encode in real time on many laptops at
  // 1080p, so frames get dropped and the video stutters; VP8 keeps up.
  const webm = mode === 'av'
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  if (format !== 'mp4') return webm;
  const mp4 = mode === 'av'
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4']
    : ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=opus', 'audio/mp4'];
  return [...mp4, ...webm];
}

function readVint(bytes, pos, keepMarker) {
  let mask = 0x80, length = 1;
  while (length <= 8 && !(bytes[pos] & mask)) { mask >>= 1; length++; }
  let value = keepMarker ? bytes[pos] : bytes[pos] & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[pos + i];
  return { value, length };
}

function encodeVint(value, length) {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = value & 0xff; value = Math.floor(value / 256); }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

// MediaRecorder writes WebM without a Duration, so players show no length and
// can't seek. Insert one into the Segment Info element (all within the header).
async function addWebmDuration(blob, durationMs) {
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const INFO = [0x15, 0x49, 0xa9, 0x66];
  const infoPos = head.findIndex((_, i) => INFO.every((b, j) => head[i + j] === b));
  if (infoPos < 0) return blob;

  const size = readVint(head, infoPos + 4);
  const bodyStart = infoPos + 4 + size.length;
  const bodyEnd = bodyStart + size.value;
  if (bodyEnd > head.length) return blob;
  for (let p = bodyStart; p < bodyEnd;) {
    const id = readVint(head, p, true);
    if (id.value === 0x4489) return blob;  // already has a Duration
    const len = readVint(head, p + id.length);
    p += id.length + len.length + len.value;
  }

  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, durationMs);  // default TimecodeScale = 1 ms
  return new Blob([
    head.subarray(0, infoPos + 4),
    encodeVint(size.value + duration.length, size.length),
    head.subarray(bodyStart, bodyEnd),
    duration,
    blob.slice(bodyEnd)
  ], { type: blob.type });
}

// MediaRecorder's MP4 is written in fragments with a zero length in its header.
// Finds the movie, track and fragment duration fields in the header (`head`,
// the file's first bytes): [{ pos, wide }] plus the timescale they count in.
function mp4DurationFields(head) {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const boxes = (start, end, visit) => {
    for (let p = start; p + 8 <= end;) {
      let size = view.getUint32(p), header = 8;
      if (size === 1) { size = Number(view.getBigUint64(p + 8)); header = 16; }
      if (size === 0) size = end - p;
      if (size < header || p + size > end) return;
      visit(String.fromCharCode(...head.subarray(p + 4, p + 8)), p + header, p + size);
      p += size;
    }
  };
  const fields = [];
  let timescale = 0;
  boxes(0, head.length, (type, start, end) => {
    if (type !== 'moov') return;
    boxes(start, end, (t, s, e) => {
      const v1 = head[s] === 1;
      if (t === 'mvhd') {
        timescale = view.getUint32(s + (v1 ? 20 : 12));
        fields.push({ pos: s + (v1 ? 24 : 16), wide: v1 });
      }
      if (t === 'trak') boxes(s, e, (t2, s2) => {
        if (t2 === 'tkhd') { const w = head[s2] === 1; fields.push({ pos: s2 + (w ? 28 : 20), wide: w }); }
      });
      if (t === 'mvex') boxes(s, e, (t2, s2) => {
        if (t2 === 'mehd') { const w = head[s2] === 1; fields.push({ pos: s2 + 4, wide: w }); }
      });
    });
  });
  return timescale ? { timescale, fields } : { timescale: 0, fields: [] };
}

// Fill in the MP4 durations where they are missing (0 or all ones).
async function addMp4Duration(blob, durationMs) {
  const headSize = Math.min(blob.size, 65536);
  const head = new Uint8Array(await blob.slice(0, headSize).arrayBuffer());
  const view = new DataView(head.buffer);
  const { timescale, fields } = mp4DurationFields(head);
  if (!timescale) return blob;
  const units = Math.round(durationMs / 1000 * timescale);
  for (const { pos, wide } of fields) {
    if (wide) {
      const old = view.getBigUint64(pos);
      if (old === 0n || old === 0xffffffffffffffffn) view.setBigUint64(pos, BigInt(units));
    } else {
      const old = view.getUint32(pos);
      if (old === 0 || old === 0xffffffff) view.setUint32(pos, Math.min(units, 0xfffffffe));
    }
  }
  return new Blob([head, blob.slice(headSize)], { type: blob.type });
}

function addDuration(blob, durationMs) {
  return (blob.type.includes('mp4') ? addMp4Duration : addWebmDuration)(blob, durationMs);
}
