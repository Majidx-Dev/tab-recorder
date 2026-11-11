const IDLE = { recording: false };

// The Quality option. "High" records at least at these bitrates, and more for
// big or 60 fps videos (`adaptive`), so the recording looks like the original.
const QUALITY = {
  low: { maxWidth: 854, maxHeight: 480, tabVideo: 1_500_000, elementVideo: 1_500_000, audio: 96_000 },
  medium: { maxWidth: 1280, maxHeight: 720, tabVideo: 3_000_000, elementVideo: 3_500_000, audio: 128_000 },
  high: { maxWidth: 1920, maxHeight: 1080, tabVideo: 5_000_000, elementVideo: 8_000_000, audio: 192_000, adaptive: true }
};


// Every recording gets an id, so messages about an earlier one are ignored.
const newRid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// "Whole tab": record at exactly the tab's own shape (scaled down to fit the
// quality's limit). Otherwise Chrome fits the tab into a 16:9 frame and adds
// black bars around it.
async function tabFrameSize(tabId, q) {
  let w = 0, h = 0;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio]
    });
    [w, h] = result;
  } catch {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) { w = tab.width; h = tab.height; }
  }
  return fitFrame(w, h, q);
}

// Scale (w, h) down to fit the quality's limit, keeping its shape.
function fitFrame(w, h, q) {
  if (!w || !h) return null;
  const scale = Math.min(1, q.maxWidth / w, q.maxHeight / h);
  const even = (n) => Math.max(2, Math.round(n * scale / 2) * 2);
  return { width: even(w), height: even(h) };
}

async function tabQuality(options, tabId) {
  const q = QUALITY[options.quality];
  return {
    maxWidth: q.maxWidth, maxHeight: q.maxHeight, videoBitsPerSecond: q.tabVideo, audioBitsPerSecond: q.audio,
    adaptive: !!q.adaptive,
    frame: await tabFrameSize(tabId, q)
  };
}

function elementOptions(options, rid, title) {
  const q = QUALITY[options.quality];
  return {
    rid, title, format: options.format,
    quality: { videoBitsPerSecond: q.elementVideo, audioBitsPerSecond: q.audio, adaptive: !!q.adaptive }
  };
}

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state || IDLE;
}

async function setState(state) {
  await chrome.storage.session.set({ state });
  chrome.action.setBadgeText({ text: state.recording ? (state.paused ? 'II' : 'REC') : '' });
  chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#5f6368' : '#d93025' });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording tab audio/video with MediaRecorder'
  });
}

// Runs inside the page (every frame): pause the playing media and rewind it to
// the start, so the recording begins with the first frame instead of mid-video.
// If nothing is playing, use the biggest video. Leaves preloaded/hidden players
// (e.g. TikTok's next video) alone so they don't start playing too.
function rewindMedia() {
  const all = [...document.querySelectorAll('video, audio')].filter((m) => m.currentSrc || m.srcObject);
  let targets = all.filter((m) => !m.paused);
  if (!targets.length) {
    const size = (m) => { const r = m.getBoundingClientRect(); return r.width * r.height; };
    const biggest = all.filter((m) => size(m) > 0).sort((a, b) => size(b) - size(a))[0];
    targets = biggest ? [biggest] : [];
  }
  for (const m of targets) {
    m.pause();
    if (Number.isFinite(m.duration)) m.currentTime = 0;  // live streams can't rewind
    m.setAttribute('data-tab-recorder', '');
  }
}

// Runs inside the page: start the media rewound above. After this the user can
// pause, seek or play anything themselves; the recording keeps capturing the tab.
function playMedia() {
  for (const m of document.querySelectorAll('[data-tab-recorder]')) {
    m.removeAttribute('data-tab-recorder');
    m.play().catch(() => {});
  }
}

// Runs inside the page: pause whatever is playing when the recording is paused,
// remembering which media it paused so resume only restarts those.
function pausePageMedia() {
  for (const m of document.querySelectorAll('video, audio')) {
    if (m.paused) continue;
    m.pause();
    m.setAttribute('data-tab-recorder-paused', '');
  }
}

// Resolves once the media is actually playing again (or after 3 s), so the
// recording resumes on moving frames instead of a frozen one.
function resumePageMedia() {
  const media = [...document.querySelectorAll('[data-tab-recorder-paused]')];
  return Promise.all(media.map((m) => new Promise((resolve) => {
    m.removeAttribute('data-tab-recorder-paused');
    const done = () => { m.removeEventListener('playing', done); resolve(); };
    m.addEventListener('playing', done);
    setTimeout(done, 3000);
    m.play().catch(done);
  }))).then(() => true);
}

async function runInTab(tabId, func) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func });
  } catch (e) {
    // Pages like chrome:// can't be scripted; recording still works without it.
    console.warn('Could not control media in tab:', e.message);
  }
}

// Inject element-recorder.js everywhere and return the frame holding the main
// video/audio, or null if there is none.
async function findMediaFrame(tabId, mode) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['element-recorder.js'] });
  const found = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (mode) => window.__tabRecorder.score(mode),
    args: [mode]
  });
  const best = found.filter((r) => r.result > 0).sort((a, b) => b.result - a.result)[0];
  return best ? best.frameId : null;
}

// Have every frame of the page follow its media pause/play/end (see 'media-event').
async function startWatching(tabId, follow) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['element-recorder.js'] });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (follow) => window.__tabRecorder.watch(follow),
      args: [follow]
    });
  } catch (e) {
    console.warn('Could not watch the page\'s videos:', e.message);
  }
}

// What a page media event means for the recording. The page itself already
// paused/resumed the recorder at the exact moment (see element-recorder.js);
// here we keep the popup's state in step and save at the end.
//  - Pause: paused, unless another video is still playing (e.g. a feed moving
//    to the next video, which then fires 'playing').
//  - Playing: recording again.
//  - End (or a looping video starting over): save.
//  - "Only the video": if its player moves on to a different video, or another
//    video starts while it is paused, that video is done: save.
// Events are handled one at a time so a quick pause+play can't interleave.
let mediaQueue = Promise.resolve();

function queueMediaEvent(msg, sender) {
  mediaQueue = mediaQueue.then(() => onMediaEvent(msg, sender)).catch(() => {});
  return mediaQueue;
}

// "Whole screen": the recording pauses when no video/audio is playing in any
// tab and resumes as soon as one plays, like the other modes but across tabs.
// A video that pauses because you switched away from its tab (TikTok does
// that) doesn't pause the recording: you didn't pause it.
const screenPlaying = new Map();  // "tab:frame" -> something playing there

async function onScreenMedia(state, msg, sender) {
  if (!(state.follow && state.follow.autoPause) || !msg.relevant) return;
  if (!['playing', 'pause', 'ended'].includes(msg.event)) return;
  screenPlaying.set(`${sender.tab.id}:${sender.frameId}`, msg.event === 'playing' || !!msg.otherPlaying);
  if (msg.event !== 'playing' && msg.hidden) return;
  const anyPlaying = [...screenPlaying.values()].some(Boolean);
  if (anyPlaying && state.paused) {
    await setState({
      ...state, paused: false, pausedAt: null,
      pausedTotal: (state.pausedTotal || 0) + (Date.now() - state.pausedAt)
    });
    await sendRecorderCommand(state, 'resume');
  } else if (!anyPlaying && !state.paused) {
    await setState({ ...state, paused: true, pausedAt: Date.now() });
    await sendRecorderCommand(state, 'pause');
  }
}

async function onMediaEvent(msg, sender) {
  const state = await getState();
  if (state.recording && !state.stopping && state.source === 'screen' && sender.tab) return onScreenMedia(state, msg, sender);
  if (!state.recording || state.stopping || !sender.tab || sender.tab.id !== state.tabId) return;
  const { autoPause, autoSave } = state.follow || {};
  const recorded = state.source === 'video' && msg.recorded && sender.frameId === state.frameId;
  if (state.source === 'video' && !recorded) {
    const recordedIdle = sender.frameId === state.frameId ? msg.recordedIdle : state.paused;
    if (autoSave && msg.event === 'playing' && msg.relevant && recordedIdle) await handle({ type: 'stop' }, sender);
    return;
  }
  if (!recorded && !msg.relevant) return;

  if ((msg.event === 'ended' || msg.event === 'switched') && autoSave) {
    await handle({ type: 'stop' }, sender);
  } else if (msg.event === 'pause' && autoPause && !state.paused && !msg.otherPlaying) {
    await setState({ ...state, paused: true, pausedAt: Date.now() });
  } else if (msg.event === 'playing' && autoPause && state.paused) {
    await setState({
      ...state, paused: false, pausedAt: null,
      pausedTotal: (state.pausedTotal || 0) + (Date.now() - state.pausedAt)
    });
  }
}

// "Only the video": find the main video/audio element in any frame and record
// it directly. Returns { ok, frameId } or { ok: false, error } so the caller can
// fall back to recording the whole tab.
async function startElementCapture(tabId, mode, opts) {
  try {
    const frameId = await findMediaFrame(tabId, mode);
    if (frameId === null) return { ok: false, error: mode === 'av' ? 'No video found on this page' : 'No audio found on this page' };
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (mode, opts) => window.__tabRecorder.start(mode, opts),
      args: [mode, opts]
    });
    if (result && result.ok) return { ok: true, frameId };
    return { ok: false, error: (result && result.error) || 'This video can\'t be recorded directly' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Pause or resume whichever recorder is running: the page's (only the video) or
// the offscreen one (whole tab).
async function sendRecorderCommand(state, command) {
  if (state.source === 'video') {
    await chrome.tabs.sendMessage(state.tabId, { type: `tab-recorder-${command}` }, { frameId: state.frameId })
      .catch(() => {});
    await chrome.runtime.sendMessage({ target: 'offscreen', type: `element-${command}`, rid: state.rid });
  } else {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: command });
  }
}

function filenameFor(title, ext) {
  const safe = title.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'recording';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${safe} ${stamp}.${ext}`;
}

// The "Save in folder" option: a folder inside Downloads, e.g. "Recordings".
function cleanFolder(folder) {
  return String(folder || '').split(/[\\/]+/)
    .map((part) => part.replace(/[:*?"<>|\x00-\x1f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function release(url) {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'release', url }).catch(() => {});
}

// Download a recording. Chrome's Save As window always opens first, already
// in Downloads (or its "Save in folder" folder) with the name filled in, so
// the user can rename it or pick another place. Cancelling (or closing) that
// window means "don't save": the recording is thrown away.
// The offscreen document keeps the recording on disk until the download is
// done, then deletes it (see downloads.onChanged below).
async function saveFile({ url, title, ext }, ask = true) {
  const { folder } = await chrome.storage.local.get('folder');
  const dir = cleanFolder(folder);
  try {
    const id = await chrome.downloads.download({
      url, filename: (dir ? `${dir}/` : '') + filenameFor(title || 'recording', ext), saveAs: ask
    });
    await chrome.storage.session.set({ [`dl-${id}`]: { url, title, ext, ask } });
    const [item] = await chrome.downloads.search({ id });
    if (item && item.state !== 'in_progress') await downloadEnded(id, item.state, item.error);
  } catch (e) {
    // The window couldn't be shown at all (not a cancel): save without it.
    if (ask && !/cancel/i.test(e.message)) return saveFile({ url, title, ext }, false);
    console.warn('Download failed:', e.message);
    release(url);
  }
}

async function downloadEnded(id, state, error) {
  const key = `dl-${id}`;
  const { [key]: rec } = await chrome.storage.session.get(key);
  if (!rec) return;
  await chrome.storage.session.remove(key);
  release(rec.url);
}

// The recording's file is finished (downloaded or failed): back to idle.
async function fileFinished(msg) {
  const state = await getState();
  if (state.recording && msg.rid && msg.rid !== state.rid) return;  // from an earlier recording
  if (msg.type === 'recording-error') await setState({ ...IDLE, error: `Recording failed: ${msg.error}` });
  else await setState(IDLE);
}

async function handle(msg, sender) {
  switch (msg.type) {
    case 'get-state':
      return getState();

    case 'start': {
      if ((await getState()).recording) return { ok: false, error: 'Already recording' };

      // "Whole screen" (browser tabs and address bar, taskbar/dock, everything)
      // with the current tab's sound. Audio only: just the tab.
      let source = msg.source === 'screen' && msg.mode !== 'av' ? 'tab' : msg.source;

      if (msg.restart) await runInTab(msg.tabId, rewindMedia);
      await ensureOffscreen();

      const options = {
        format: msg.format === 'mp4' ? 'mp4' : 'webm',
        quality: msg.quality in QUALITY ? msg.quality : 'high'
      };
      const rid = newRid();
      const follow = { autoPause: !!msg.autoPause, autoSave: !!msg.autoSave };

      if (source === 'screen') {
        // Chrome shows its screen chooser only to an extension page, which then
        // records the screen itself: open screen.html in a small window. It
        // reports back with 'screen-started' or 'screen-failed'.
        await chrome.storage.session.set({
          [`screen-${rid}`]: {
            tabId: msg.tabId, mode: msg.mode, title: msg.title, restart: !!msg.restart, options, follow,
            // The tab's sound: the popup's stream id, used before the screen chooser opens.
            streamId: msg.streamId,
            format: options.format, quality: await tabQuality(options, msg.tabId)
          }
        });
        await chrome.windows.create({ url: `screen.html#${rid}`, type: 'popup', width: 460, height: 240, focused: true });
        return { ok: true };
      }

      let frameId, res = { ok: true };
      const notes = [];
      if (source === 'video') {
        const element = await startElementCapture(msg.tabId, msg.mode, elementOptions(options, rid, msg.title));
        if (element.ok) {
          frameId = element.frameId;
        } else {
          source = 'tab';
          notes.push(`${element.error} — recording the whole tab instead.`);
        }
      }
      if (source === 'tab') {
        res = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'start', streamId: msg.streamId, mode: msg.mode,
          format: options.format, quality: await tabQuality(options, msg.tabId), rid, title: msg.title
        });
        if (res && res.note) notes.push(res.note);
      }
      const note = notes.join(' ') || undefined;

      if (msg.restart) await runInTab(msg.tabId, playMedia);
      if (res && res.ok) {
        await setState({
          recording: true, mode: msg.mode, title: msg.title, startedAt: Date.now(),
          source, tabId: msg.tabId, frameId, note, rid, options, follow
        });
        if (follow.autoPause || follow.autoSave) {
          await startWatching(msg.tabId, { ...follow, source });
        }
      }
      return res;
    }

    // From screen.html: the screen is being recorded, or it couldn't be.
    case 'screen-started': {
      const key = `screen-${msg.rid}`;
      const p = (await chrome.storage.session.get(key))[key];
      if (!p) return { ok: false };
      await chrome.storage.session.remove(key);
      if (p.restart) await runInTab(p.tabId, playMedia);
      const notes = [msg.noSound ? 'The sound couldn\'t be recorded — recording the picture only.' : null].filter(Boolean);
      await setState({
        recording: true, mode: p.mode, title: p.title, startedAt: Date.now(), source: 'screen',
        tabId: p.tabId, windowId: msg.windowId, note: notes.join(' ') || undefined, rid: msg.rid,
        options: p.options, follow: p.follow, relay: !msg.computerSound && !msg.noSound
      });
      // Without the computer's sound, every other tab sends the sound of what
      // plays in it (tab-sound.js); tabs opened or loaded later get it too.
      screenPlaying.clear();
      for (const tab of await chrome.tabs.query({})) {
        if (!msg.computerSound && !msg.noSound && tab.id !== p.tabId) relaySound(tab.id);
        if (p.follow.autoPause) watchScreenTab(tab.id);
      }
      // The whole screen isn't tied to one tab's video: it keeps recording while
      // you move between tabs and apps, and pauses/resumes with the videos in
      // all of them (onScreenMedia); it doesn't save when one video ends.
      return { ok: true };
    }

    case 'screen-failed': {
      const key = `screen-${msg.rid}`;
      const p = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      if (p && p.restart) await runInTab(p.tabId, playMedia);
      await setState({ ...IDLE, error: msg.error });
      return { ok: true };
    }

    // The state is updated before touching the page, so the pause/play events
    // our own pausePageMedia/resumePageMedia cause are ignored as no-ops.
    case 'pause': {
      const state = await getState();
      if (!state.recording || state.paused) return { ok: true };
      await setState({ ...state, paused: true, pausedAt: Date.now() });
      // Fade out and pause the recording first, then the media, so the file has
      // no frozen frames or pause icon.
      await sendRecorderCommand(state, 'pause');
      await runInTab(state.tabId, pausePageMedia);
      return { ok: true };
    }

    case 'resume': {
      const state = await getState();
      if (!state.recording || !state.paused) return { ok: true };
      await setState({
        ...state, paused: false, pausedAt: null,
        pausedTotal: (state.pausedTotal || 0) + (Date.now() - state.pausedAt)
      });
      // Media first, recording once it is really playing (fading the audio in),
      // so the file never shows a frozen frame at the joint.
      await runInTab(state.tabId, resumePageMedia);
      await sendRecorderCommand(state, 'resume');
      return { ok: true };
    }

    // From the page watcher (see startWatching).
    case 'media-event':
      await queueMediaEvent(msg, sender);
      return { ok: true };

    case 'stop': {
      const state = await getState();
      // A video's end can be reported twice (ended + loop restart); stop once.
      if (state.stopping && Date.now() - state.stopping < 5000) return { ok: true };
      if (state.recording) await setState({ ...state, stopping: Date.now() });
      if (state.tabId !== undefined) {
        await runInTab(state.tabId, () => window.__tabRecorder && window.__tabRecorder.unwatch());
      }
      if (state.source === 'screen') {
        // Every tab: stop following its videos and sending its sound (tab-sound.js).
        for (const tab of await chrome.tabs.query({})) {
          if (tab.id !== state.tabId) runInTab(tab.id, () => window.__tabRecorder && window.__tabRecorder.unwatch());
          if (state.relay) chrome.tabs.sendMessage(tab.id, { type: 'snd-stop' }).catch(() => {});
        }
      }
      if (state.source === 'video') {
        try {
          await chrome.tabs.sendMessage(state.tabId, { type: 'tab-recorder-stop' }, { frameId: state.frameId });
        } catch {
          // The page was reloaded or closed; save what was recorded so far.
          await chrome.runtime.sendMessage({ target: 'offscreen', type: 'element-done', rid: state.rid });
        }
      } else {
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
      }
      return { ok: true };
    }

    // The recording is over the moment its file is ready: end it (badge, popup)
    // before Chrome's Save As window opens, not after the user closes it.
    case 'recording-ready':
      await fileFinished(msg);
      await saveFile(msg);
      return { ok: true };

    case 'recording-error':
      await fileFinished(msg);
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return;
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

// "Only the video" recordings live in the page; if its tab closes, save what we have.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.recording && state.source === 'video' && state.tabId === tabId) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'element-done', rid: state.rid }).catch(() => {});
  }
});

// A download finished (or failed): its recording can be deleted from disk.
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current !== 'in_progress') {
    downloadEnded(delta.id, delta.state.current, delta.error && delta.error.current);
  }
});

function watchScreenTab(tabId) {
  startWatching(tabId, { autoPause: true, autoSave: false, source: 'screen' });
}

function relaySound(tabId) {
  chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['tab-sound.js'] }).catch(() => {});
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const state = await getState();
  if (!state.recording || state.stopping || state.source !== 'screen') return;
  if (state.relay && tabId !== state.tabId) relaySound(tabId);
  if (state.follow && state.follow.autoPause) watchScreenTab(tabId);
});

// "Whole screen": its recording window was closed mid-recording; save what
// reached the offscreen document.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const state = await getState();
  if (state.recording && !state.stopping && state.source === 'screen' && state.windowId === windowId) {
    await setState({ ...state, stopping: Date.now() });
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'element-done', rid: state.rid }).catch(() => {});
  }
});

// Clear a stale badge/state if the browser restarted mid-recording.
chrome.runtime.onStartup.addListener(() => setState(IDLE));
