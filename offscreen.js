let recorder = null;

function pickMimeType(mode, format) {
  return mimeCandidates(mode, format).find((t) => MediaRecorder.isTypeSupported(t));
}


// Recording time excluding pauses, used for the file's Duration.
function makeClock() { return { startedAt: performance.now(), pausedAt: null, pausedTotal: 0 }; }
function pauseClock(c) { if (c && c.pausedAt === null) c.pausedAt = performance.now(); }
function resumeClock(c) {
  if (c && c.pausedAt !== null) { c.pausedTotal += performance.now() - c.pausedAt; c.pausedAt = null; }
}
function elapsed(c) { return (c.pausedAt ?? performance.now()) - c.startedAt - c.pausedTotal; }

// While recording, every second of data is written straight to disk (the
// extension's own storage) and dropped from memory, so long recordings don't
// fill up RAM. At Stop the file is downloaded into Downloads and then deleted
// from that storage. If the disk storage can't be used, the data is kept in
// memory instead (the old way).
const cleanup = clearRecordings();  // left over from an earlier session

async function clearRecordings() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('recordings', { recursive: true });
  } catch {
    // Nothing to clear.
  }
}

function makeSink(rid) {
  let disk = null, error = null, size = 0;
  const memory = [];
  let queue = cleanup.then(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('recordings', { create: true });
      const handle = await dir.getFileHandle(rid, { create: true });
      disk = { dir, handle, writable: await handle.createWritable() };
    } catch {
      disk = null;  // no disk storage: keep it in memory
    }
  });
  return {
    get size() { return size; },
    write(data) {
      size++;
      queue = queue.then(async () => {
        if (error) return;
        if (disk) await disk.writable.write(data); else memory.push(data);
      }).catch((e) => { error = error || e; });
    },
    // The whole recording as a Blob (backed by the file on disk, not by RAM).
    async finish(type) {
      await queue;
      if (!disk) return new Blob(memory, { type });
      if (!error) await disk.writable.close().catch((e) => { error = e; });
      if (error) throw new Error(`Could not write the recording to disk (${error.message})`);
      const file = await disk.handle.getFile();
      return file.slice(0, file.size, type);
    },
    async remove() {
      await queue;
      memory.length = 0;
      if (disk) {
        await disk.writable.abort().catch(() => {});
        await disk.dir.removeEntry(rid).catch(() => {});
      }
    }
  };
}

// Finished recordings by blob URL, kept until the background says the
// download is done (see 'release').
const ready = new Map();

// Chrome's MP4 with Opus sound (Chrome on Linux) is written in fragments, and
// each fragment's sound is stamped ~40 ms later than where the previous one
// ended (and the packets get uneven lengths). Players play those jumps as tiny
// gaps: a tick every few seconds. The sound itself is all there, so give every
// sound packet its true length (read from the Opus packet) and start each
// fragment's sound exactly where the previous one ended. Only a few bytes per
// fragment change; anything unexpected leaves the file as it is.
async function fixMp4Audio(blob) {
  const read = async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  const setU32 = (b, p, v) => { b[p] = v >>> 24; b[p + 1] = v >>> 16; b[p + 2] = v >>> 8; b[p + 3] = v; };
  const type = (b, p) => String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
  const children = function* (b, start, end) {
    for (let p = start; p + 8 <= end;) {
      const size = u32(b, p);
      if (size < 8 || p + size > end) return;
      yield { type: type(b, p), start: p, body: p + 8, end: p + size };
      p += size;
    }
  };
  // Samples per Opus packet (48 kHz): frame size from the TOC byte × frame count.
  const opusSamples = (b0, b1) => {
    const config = b0 >> 3, code = b0 & 3;
    const frame = config < 12 ? [480, 960, 1920, 2880][config % 4]
      : config < 16 ? [480, 960][config % 2]
      : [120, 240, 480, 960][config % 4];
    return frame * (code === 0 ? 1 : code < 3 ? 2 : (b1 & 0x3f));
  };

  // Top-level boxes: [{ type, start, end }], reading only their headers.
  const top = [];
  for (let p = 0; p + 8 <= blob.size;) {
    const h = await read(p, p + 16);
    let size = u32(h, 0);
    if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12);
    if (size === 0) size = blob.size - p;
    if (size < 8) return blob;
    top.push({ type: type(h, 0), start: p, end: p + size });
    p += size;
  }

  // The Opus sound track's id, from moov.
  const moovBox = top.find((b) => b.type === 'moov');
  if (!moovBox) return blob;
  const moov = await read(moovBox.start, moovBox.end);
  let soundId = null;
  for (const trak of children(moov, 8, moov.length)) {
    if (trak.type !== 'trak') continue;
    let id = null, sound = false, opus = false;
    for (const b of children(moov, trak.body, trak.end)) {
      if (b.type === 'tkhd') id = u32(moov, b.body + (moov[b.body] === 1 ? 20 : 12));
      if (b.type !== 'mdia') continue;
      for (const m of children(moov, b.body, b.end)) {
        if (m.type === 'hdlr') sound = type(moov, m.body + 4) === 'soun';
        if (m.type !== 'minf') continue;
        for (const s of children(moov, m.body, m.end)) {
          if (s.type !== 'stbl') continue;
          for (const st of children(moov, s.body, s.end)) {
            if (st.type === 'stsd') opus = type(moov, st.body + 8) === 'Opus';
          }
        }
      }
    }
    if (sound && opus) soundId = id;
  }
  if (soundId === null) return blob;

  let next = null;  // where the next fragment's sound should start
  const parts = [];
  for (const box of top) {
    if (box.type !== 'moof') { parts.push(blob.slice(box.start, box.end)); continue; }
    const moof = await read(box.start, box.end);
    for (const traf of children(moof, 8, moof.length)) {
      if (traf.type !== 'traf') continue;
      let tfhd = null, tfdt = null, trun = null;
      for (const b of children(moof, traf.body, traf.end)) {
        if (b.type === 'tfhd') tfhd = b;
        if (b.type === 'tfdt') tfdt = b;
        if (b.type === 'trun') trun = b;
      }
      if (!tfhd || !tfdt || !trun || u32(moof, tfhd.body + 4) !== soundId) continue;
      const tfhdFlags = u32(moof, tfhd.body) & 0xffffff;
      const flags = u32(moof, trun.body) & 0xffffff;
      // Sample offsets relative to the moof, durations and sizes listed per sample.
      if (tfhdFlags & 1 || !(flags & 1) || !(flags & 0x100) || !(flags & 0x200)) return blob;
      const count = u32(moof, trun.body + 4);
      const dataStart = box.start + (u32(moof, trun.body + 8) | 0);
      let q = trun.body + 12 + (flags & 4 ? 4 : 0);
      const entries = [];
      let dataSize = 0;
      for (let i = 0; i < count; i++) {
        const size = u32(moof, q + 4);
        entries.push({ durationAt: q, size });
        dataSize += size;
        q += 8 + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
      }
      const data = await read(dataStart, dataStart + dataSize);
      let pos = 0, total = 0;
      for (const e of entries) {
        if (e.size < 2) return blob;
        const samples = opusSamples(data[pos], data[pos + 1]);
        setU32(moof, e.durationAt, samples);
        total += samples;
        pos += e.size;
      }
      const v1 = moof[tfdt.body] === 1;
      const at = tfdt.body + 4;
      const current = v1 ? u32(moof, at) * 2 ** 32 + u32(moof, at + 4) : u32(moof, at);
      if (next === null) next = current;
      if (v1) { setU32(moof, at, Math.floor(next / 2 ** 32)); setU32(moof, at + 4, next % 2 ** 32); } else setU32(moof, at, next);
      next += total;
    }
    parts.push(moof);
  }
  return new Blob(parts, { type: blob.type });
}

async function save(sink, mimeType, durationMs, rid, title) {
  try {
    if (!sink.size) {
      await sink.remove();
      chrome.runtime.sendMessage({ type: 'recording-error', rid, error: 'Nothing was recorded' });
      return;
    }
    let raw = await sink.finish(mimeType);
    if (mimeType.includes('mp4')) raw = await fixMp4Audio(raw).catch(() => raw);
    const blob = await addDuration(raw, durationMs).catch(() => raw);
    const url = URL.createObjectURL(blob);
    ready.set(url, sink);
    chrome.runtime.sendMessage({ type: 'recording-ready', rid, url, ext: extForMime(mimeType), title });
  } catch (e) {
    await sink.remove();
    chrome.runtime.sendMessage({ type: 'recording-error', rid, error: e.message });
  }
}

function release(url) {
  const sink = ready.get(url);
  if (!sink) return;
  ready.delete(url);
  URL.revokeObjectURL(url);
  sink.remove();
}

// "Only the video" recordings arrive from element-recorder.js in the page, one
// base64 chunk per second; collect them here so they survive the page closing.
let element = null;
let tabClock = null;
let tabFade = null;

// Ramp the recorded audio to `value` over `ms`; resolves when done.
function fadeTo(fade, value, ms) {
  if (!fade) return Promise.resolve();
  const t = fade.ctx.currentTime;
  fade.gain.gain.cancelScheduledValues(t);
  fade.gain.gain.setValueAtTime(fade.gain.gain.value, t);
  fade.gain.gain.linearRampToValueAtTime(value, t + ms / 1000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Whole-tab pause/resume. `immediate` = the page's video already stopped (its
// sound is already silent), so pause at once instead of fading first.
async function pauseTab(immediate) {
  if (!recorder || recorder.state !== 'recording') return;
  if (!immediate) await fadeTo(tabFade, 0, 30);
  if (recorder.state === 'recording') { recorder.pause(); pauseClock(tabClock); }
}

function resumeTab() {
  if (!recorder || recorder.state !== 'paused') return;
  if (tabFade) tabFade.gain.gain.setValueAtTime(0, tabFade.ctx.currentTime);
  recorder.resume();
  resumeClock(tabClock);
  fadeTo(tabFade, 1, 40);
}

function dataUrlToBytes(dataUrl) {
  // The MIME type itself contains a comma ("codecs=vp9,opus"), base64 never does.
  const binary = atob(dataUrl.slice(dataUrl.lastIndexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The tab's own shape when known (no black bars), else the quality's limit.
function frameConstraints(quality) {
  const f = quality.frame;
  if (!f) return { maxWidth: quality.maxWidth, maxHeight: quality.maxHeight };
  return { minWidth: f.width, maxWidth: f.width, minHeight: f.height, maxHeight: f.height };
}

async function start({ streamId, mode, format, quality, rid, title }) {
  if (recorder && recorder.state !== 'inactive') throw new Error('Already recording');

  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: source },
    video: mode === 'av' ? { mandatory: { ...source, ...frameConstraints(quality), maxFrameRate: 30 } } : false
  });

  // Capturing mutes the tab for the user; route the audio back to the speakers.
  // The recorded audio goes through a gain node so pause/resume can fade it
  // instead of cutting it (an abrupt cut is an audible click at the joint).
  const audioCtx = new AudioContext();
  const audioOut = audioCtx.createMediaStreamDestination();
  tabFade = null;
  if (media.getAudioTracks().length) {
    const audioIn = audioCtx.createMediaStreamSource(media);
    audioIn.connect(audioCtx.destination);
    const gain = audioCtx.createGain();
    audioIn.connect(gain).connect(audioOut);
    tabFade = { ctx: audioCtx, gain };
  }

  const mimeType = pickMimeType(mode, format);
  const sink = makeSink(rid);
  recorder = new MediaRecorder(new MediaStream([...media.getVideoTracks(), ...(tabFade ? audioOut.stream.getAudioTracks() : [])]), {
    mimeType,
    videoBitsPerSecond: videoBitrate(quality, media.getVideoTracks()[0]),
    audioBitsPerSecond: quality.audioBitsPerSecond
  });

  recorder.ondataavailable = (e) => { if (e.data.size) sink.write(e.data); };
  recorder.onstop = () => {
    media.getTracks().forEach((t) => t.stop());
    audioCtx.close();
    save(sink, mimeType, elapsed(clock), rid, title);
  };
  recorder.onerror = (e) => {
    media.getTracks().forEach((t) => t.stop());
    audioCtx.close();
    sink.remove();
    chrome.runtime.sendMessage({ type: 'recording-error', rid, error: String(e.error || e) });
  };

  // Stop automatically if the tab is closed or capture ends.
  media.getTracks().forEach((t) => {
    t.onended = () => { if (recorder.state !== 'inactive') recorder.stop(); };
  });

  const clock = tabClock = makeClock();
  recorder.start(1000);
  return {};
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg).then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'release') {
    release(msg.url);
    sendResponse({ ok: true });
  }
  if (msg.type === 'stop') {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    sendResponse({ ok: true });
  }
  if (msg.type === 'pause') {
    pauseTab(msg.immediate).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'resume') {
    resumeTab();
    sendResponse({ ok: true });
  }
  if (msg.type === 'element-start') {
    element = { rid: msg.rid, title: msg.title, mimeType: msg.mimeType, sink: makeSink(msg.rid), clock: makeClock() };
    sendResponse({ ok: true });
  }
  // The page pauses/resumes its own recorder; these only keep the duration right.
  if (msg.type === 'element-pause') {
    if (element) pauseClock(element.clock);
    sendResponse({ ok: true });
  }
  if (msg.type === 'element-resume') {
    if (element) resumeClock(element.clock);
    sendResponse({ ok: true });
  }
  if (msg.type === 'element-chunk') {
    if (element) element.sink.write(dataUrlToBytes(msg.data));
    sendResponse({ ok: true });
  }
  if (msg.type === 'element-done') {
    // Can arrive twice (page stop + tab closed); only the first one saves.
    if (element) {
      const { sink, mimeType, clock, rid, title } = element;
      element = null;
      save(sink, mimeType, elapsed(clock), rid, title);
    } else {
      chrome.runtime.sendMessage({ type: 'recording-error', error: 'Nothing was recorded' });
    }
    sendResponse({ ok: true });
  }
});
