// Injected into the page (every frame).
// "Only the video": records the <video>/<audio> element itself, so the page
// around it is not in the file, and streams the data to the offscreen document,
// which saves it. Both modes: follows the page's media pause/play/end.
(() => {
  if (window.__tabRecorder) return;
  let recorder = null;
  let recordedEl = null;
  let fade = null;  // { ctx, gain } when the recorded audio can be faded
  let rid = null;   // id of the current recording, sent with every message

  function findMedia(mode) {
    let best = null, bestScore = 0;
    for (const el of document.querySelectorAll(mode === 'av' ? 'video' : 'video, audio')) {
      if (!el.currentSrc && !el.srcObject) continue;
      if (mode === 'av' && !el.videoWidth) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(1, r.width * r.height);
      // Prefer media that is playing (or was just rewound by "play from the beginning") and audible.
      const active = !el.paused || el.hasAttribute('data-tab-recorder');
      const score = area * (active ? 10 : 1) * (el.muted ? 0.5 : 1);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return { el: best, score: bestScore };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Messages must reach the offscreen document in order, so send them one at a time.
  let queue = Promise.resolve();
  const send = (makeMessage) => {
    queue = queue.then(async () => chrome.runtime.sendMessage(await makeMessage())).catch(() => {});
  };

  // Route the recorded audio through a gain node so pause/resume can fade it
  // instead of cutting it. Pages can block audio until the user interacts; if
  // the AudioContext won't run, record the audio as is (no fades).
  async function fadeableAudio(audioTracks) {
    if (!audioTracks.length) return audioTracks;
    try {
      const ctx = new AudioContext();
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 500))]);
      if (ctx.state !== 'running') { ctx.close(); return audioTracks; }
      const gain = ctx.createGain();
      const out = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(new MediaStream(audioTracks)).connect(gain).connect(out);
      fade = { ctx, gain };
      return out.stream.getAudioTracks();
    } catch {
      return audioTracks;
    }
  }

  function fadeTo(value, ms) {
    if (!fade) return Promise.resolve();
    const t = fade.ctx.currentTime;
    fade.gain.gain.cancelScheduledValues(t);
    fade.gain.gain.setValueAtTime(fade.gain.gain.value, t);
    fade.gain.gain.linearRampToValueAtTime(value, t + ms / 1000);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // `immediate` = the video already stopped (silent, no new frames): pause at
  // once. Otherwise fade the audio out first so the cut isn't audible.
  async function pauseRecording(immediate) {
    if (!recorder || recorder.state !== 'recording') return;
    if (!immediate) await fadeTo(0, 30);
    if (recorder.state !== 'recording') return;
    recorder.pause();
    const id = rid;
    send(() => ({ target: 'offscreen', type: 'element-pause', rid: id }));
  }

  function resumeRecording() {
    if (!recorder || recorder.state !== 'paused') return;
    if (fade) fade.gain.gain.setValueAtTime(0, fade.ctx.currentTime);
    recorder.resume();
    const id = rid;
    send(() => ({ target: 'offscreen', type: 'element-resume', rid: id }));
    fadeTo(1, 40);
  }

  // "High": enough bitrate for the video's own size and frame rate (about 0.1
  // bit per pixel per frame), never below the preset, at most 25 Mbps. Same
  // rule as videoBitrate in recording-file.js.
  function videoBitrate(quality, track, el) {
    if (!quality.adaptive || !track) return quality.videoBitsPerSecond;
    const s = track.getSettings();
    const width = s.width || el.videoWidth, height = s.height || el.videoHeight;
    const needed = Math.round(width * height * Math.min(s.frameRate || 30, 60) * 0.1);
    return Math.min(25_000_000, Math.max(quality.videoBitsPerSecond, needed));
  }

  // opts: { rid, title, format, quality: { videoBitsPerSecond, audioBitsPerSecond, adaptive } }
  async function start(mode, opts) {
    if (recorder && recorder.state !== 'inactive') return { ok: false, error: 'Already recording' };
    const { el } = findMedia(mode);
    if (!el) return { ok: false, error: 'No video found on this page' };

    let stream;
    try {
      stream = el.captureStream();  // throws for DRM-protected or cross-origin media
    } catch (e) {
      return { ok: false, error: 'This video can\'t be recorded directly' };
    }
    if (mode === 'av' && !stream.getVideoTracks().length) return { ok: false, error: 'This video can\'t be recorded directly' };
    if (mode !== 'av' && !stream.getAudioTracks().length) return { ok: false, error: 'No audio found on this page' };
    recordedEl = el;

    if (fade) { fade.ctx.close(); fade = null; }
    const audio = await fadeableAudio(stream.getAudioTracks());
    const tracks = mode === 'av' ? [...stream.getVideoTracks(), ...audio] : audio;

    // MP4: AAC sound where Chrome can make it, else Opus (see mimeCandidates in
    // recording-file.js).
    // VP8 before VP9 (VP9 is too slow at 1080p on many laptops: stutter).
    const webm = mode === 'av'
      ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
      : ['audio/webm;codecs=opus', 'audio/webm'];
    const mp4 = mode === 'av'
      ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4']
      : ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=opus', 'audio/mp4'];
    const mimeType = [...(opts.format === 'mp4' ? mp4 : []), ...webm].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      videoBitsPerSecond: videoBitrate(opts.quality, stream.getVideoTracks()[0], el),
      audioBitsPerSecond: opts.quality.audioBitsPerSecond
    });

    const id = rid = opts.rid;
    send(() => ({ target: 'offscreen', type: 'element-start', rid: id, mimeType, title: opts.title }));
    recorder.ondataavailable = (e) => {
      if (e.data.size) send(async () => ({ target: 'offscreen', type: 'element-chunk', rid: id, data: await blobToDataUrl(e.data) }));
    };
    const stopped = recorder;
    recorder.onstop = () => {
      send(() => ({ target: 'offscreen', type: 'element-done', rid: id }));
      if (fade && recorder === stopped) { fade.ctx.close(); fade = null; }
    };
    recorder.start(1000);
    return { ok: true };
  }

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return Math.max(0, w) * Math.max(0, h);
  }

  // Media the user is actually watching or hearing: big and on screen, or audible.
  // Skips preloaded off-screen feed videos (TikTok, Shorts) and muted previews.
  function isRelevant(el) {
    if (el === recordedEl) return true;
    if (el.tagName === 'AUDIO') return !el.muted && el.volume > 0;
    return visibleArea(el) >= 40000 || (!el.muted && el.volume > 0 && visibleArea(el) > 0);
  }

  function otherRelevantPlaying(el) {
    return [...document.querySelectorAll('video, audio')]
      .some((m) => m !== el && !m.paused && !m.ended && isRelevant(m));
  }

  // Follow every video/audio pause, play and end in this frame. Listening on the
  // document (capture phase) catches all players, including ones a site creates
  // or swaps later, e.g. TikTok's next video after scrolling. Buffering and
  // seeking don't fire "pause", so they don't interrupt the recording.
  //
  // To keep the joints invisible, the recorder is paused right here, the moment
  // the video stops (before the player can draw its pause icon), and resumed on
  // "playing", when frames are actually moving again (not on "play", which fires
  // before the video has started). The background is told too, to update the
  // popup and to save at the end.
  let follow = null;  // { autoPause, autoSave, source } while watching
  const lastTime = new WeakMap();

  function report(event, el, extra) {
    chrome.runtime.sendMessage({
      type: 'media-event', event,
      recorded: el === recordedEl,
      relevant: isRelevant(el),
      recordedIdle: !!recordedEl && (recordedEl.paused || recordedEl.ended || !recordedEl.isConnected),
      hidden: document.hidden,  // the tab is in the background (sites pause videos then)
      ...extra
    }).catch(() => {});
  }

  function pauseFromPage(el) {
    if (!follow.autoPause) return;
    // ("Whole screen" follows every tab at once: the background decides.)
    if (follow.source === 'video') {
      if (el === recordedEl) pauseRecording(true);
    } else if (follow.source === 'tab' && isRelevant(el) && !otherRelevantPlaying(el)) {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'pause', immediate: true }).catch(() => {});
    }
  }

  function resumeFromPage(el) {
    if (!follow.autoPause) return;
    if (follow.source === 'video') {
      if (el === recordedEl) resumeRecording();
    } else if (follow.source === 'tab' && isRelevant(el)) {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'resume' }).catch(() => {});
    }
  }

  function onMediaEvent(e) {
    const el = e.target;
    if (!(el instanceof HTMLMediaElement) || !follow) return;
    switch (e.type) {
      case 'pause':
        if (el.ended) return;  // reported by 'ended'
        pauseFromPage(el);
        if (isRelevant(el)) el.setAttribute('data-tab-recorder-paused', '');  // so Resume in the popup plays it again
        report('pause', el, { otherPlaying: otherRelevantPlaying(el) });
        break;
      case 'playing':
        resumeFromPage(el);
        if (isRelevant(el)) {
          for (const m of document.querySelectorAll('[data-tab-recorder-paused]')) m.removeAttribute('data-tab-recorder-paused');
        }
        report('playing', el);
        break;
      case 'ended':
        report('ended', el);
        break;
      case 'loadstart':
        // The recorded player got a new video (some sites reuse one player).
        if (el === recordedEl && recorder && recorder.state !== 'inactive') report('switched', el);
        break;
      case 'timeupdate': {
        // Looping videos never fire 'ended': treat jumping from the end back to the start as the end.
        const prev = lastTime.get(el);
        lastTime.set(el, el.currentTime);
        if (prev !== undefined && Number.isFinite(el.duration) && el.duration > 3 &&
            prev > el.duration - 1.5 && el.currentTime < 1) report('ended', el);
        break;
      }
    }
  }

  const MEDIA_EVENTS = ['pause', 'playing', 'ended', 'loadstart', 'timeupdate'];

  function watch(opts) {
    if (!follow) for (const t of MEDIA_EVENTS) document.addEventListener(t, onMediaEvent, true);
    follow = opts;
  }

  function unwatch() {
    for (const t of MEDIA_EVENTS) document.removeEventListener(t, onMediaEvent, true);
    follow = null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!recorder) return;
    if (msg.type === 'tab-recorder-stop') {
      if (recorder.state !== 'inactive') recorder.stop();
    } else if (msg.type === 'tab-recorder-pause') {
      pauseRecording(false).then(() => sendResponse({ ok: true }));
      return true;
    } else if (msg.type === 'tab-recorder-resume') {
      resumeRecording();
    } else {
      return;
    }
    sendResponse({ ok: true });
  });

  window.__tabRecorder = { score: (mode) => findMedia(mode).score, start, watch, unwatch };
})();
