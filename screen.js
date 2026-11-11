// "Whole screen": Chrome only shows its screen chooser to an extension page (not
// to the background), and the chosen screen can only be recorded by the page
// that asked. So this small window asks, records the screen with the current
// tab's sound, and sends the recording to the offscreen document piece by
// piece, the same way "Only the video" does (see element-recorder.js), which
// saves it. The window minimizes itself while recording and closes at the end.
const rid = location.hash.slice(1);
const statusEl = document.getElementById('status');
let recorder = null;
let fade = null;  // { ctx, gain } to fade the sound at pause/resume

function fail(error) {
  statusEl.textContent = error;
  statusEl.className = 'error';
  chrome.runtime.sendMessage({ type: 'screen-failed', rid, error });
  setTimeout(closeWindow, 4000);
}

async function closeWindow() {
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (win) chrome.windows.remove(win.id); else window.close();
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

function fadeTo(value, ms) {
  if (!fade) return Promise.resolve();
  const t = fade.ctx.currentTime;
  fade.gain.gain.cancelScheduledValues(t);
  fade.gain.gain.setValueAtTime(fade.gain.gain.value, t);
  fade.gain.gain.linearRampToValueAtTime(value, t + ms / 1000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same as pause/resume of the whole-tab recording in offscreen.js.
async function pause(immediate) {
  if (!recorder || recorder.state !== 'recording') return;
  if (!immediate) await fadeTo(0, 30);
  if (recorder.state !== 'recording') return;
  recorder.pause();
  send(() => ({ target: 'offscreen', type: 'element-pause', rid }));
}

function resume() {
  if (!recorder || recorder.state !== 'paused') return;
  if (fade) fade.gain.gain.setValueAtTime(0, fade.ctx.currentTime);
  recorder.resume();
  send(() => ({ target: 'offscreen', type: 'element-resume', rid }));
  fadeTo(1, 40);
}

// The background (and the page's video watcher) send the whole-tab commands to
// the offscreen document; while the screen is recorded, they are for this page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen' || !recorder) return;
  if (msg.type === 'stop') {
    if (recorder.state !== 'inactive') recorder.stop();
  } else if (msg.type === 'pause') {
    pause(msg.immediate);
  } else if (msg.type === 'resume') {
    resume();
  }
});

// Chrome only lets a page play and route sound (AudioContext) after a click in
// that page, and this window opens without one. So it takes the tab's sound
// right away, then waits for the "Start recording" click before turning the
// sound on and asking for the screen; without the click the sound would be
// silent in the recording and muted for the user.
const startBtn = document.getElementById('start');

// The other tabs' sound, sent by tab-sound.js over WebRTC (see there) and mixed
// into the recording's gain node; the tabs keep playing it themselves.
let relayInto = null;  // { ctx, gain } while recording without the computer's sound
const relays = new Map();  // id -> { pc, tabId, frameId }

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.target !== 'screen' || !sender.tab) return;
  if (msg.type === 'snd-offer') acceptSound(msg, sender).catch(() => {});
  if (msg.type === 'snd-ice' && relays.has(msg.id)) relays.get(msg.id).pc.addIceCandidate(msg.candidate).catch(() => {});
});

async function acceptSound(msg, sender) {
  if (!relayInto || !recorder || recorder.state === 'inactive') return;
  const reply = (m) => chrome.tabs.sendMessage(sender.tab.id, m, { frameId: sender.frameId }).catch(() => {});
  const pc = new RTCPeerConnection();
  relays.set(msg.id, { pc, tabId: sender.tab.id, frameId: sender.frameId });
  pc.onicecandidate = (e) => { if (e.candidate) reply({ type: 'snd-ice', id: msg.id, candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    const stream = new MediaStream([e.track]);
    // Chrome only feeds a received stream to the sound engine while a media
    // element is playing it (muted here: the tab itself is audible already).
    const sink = new Audio();
    sink.muted = true;
    sink.srcObject = stream;
    sink.play().catch(() => {});
    relayInto.ctx.createMediaStreamSource(stream).connect(relayInto.gain);
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  reply({ type: 'snd-answer', id: msg.id, sdp: answer.sdp });
}

function endRelays() {
  const tabs = new Set();
  for (const { pc, tabId } of relays.values()) { pc.close(); tabs.add(tabId); }
  for (const tabId of tabs) chrome.tabs.sendMessage(tabId, { type: 'snd-stop' }).catch(() => {});
  relays.clear();
  relayInto = null;
}

async function start() {
  const key = `screen-${rid}`;
  const params = (await chrome.storage.session.get(key))[key];
  if (!params) return fail('This recording request is no longer valid.');
  const { tabId, format, quality, title, streamId } = params;

  // The current tab's sound, taken first: the stream id the popup got when
  // Record was clicked only works for a few seconds, and Chrome won't give this
  // window a new one. Capturing it mutes the tab, so it is played back below.
  let sound = null;
  for (const id of [streamId, null]) {
    try {
      const useId = id || await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      sound = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: useId } }
      });
      break;
    } catch {
      // Try the next way; without sound the picture is still recorded.
    }
  }

  statusEl.textContent = 'Click Start recording, then choose your screen and press Share.';
  startBtn.disabled = false;
  startBtn.focus();
  await new Promise((resolve) => { startBtn.onclick = resolve; });
  startBtn.disabled = true;
  statusEl.textContent = "Choose your screen in Chrome's window and press Share.";

  // Within the click: start the sound engine (playback and pause/resume fades).
  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  const giveUp = (error) => {
    if (sound) sound.getTracks().forEach((t) => t.stop());
    ctx.close();
    return fail(error);
  };

  // The whole screen, and the computer's own sound (every tab and app) where
  // Chrome can share it: its chooser then shows "Share system audio" (Windows,
  // ChromeOS, some Linux). Otherwise the sound of the tab recording started from.
  const choice = await new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(['screen', 'audio'], (id, options) => {
      resolve({ id: id || '', audio: !!(options && options.canRequestAudioTrack) });
    });
  });
  if (!choice.id) return giveUp('No screen was chosen');

  // The screen at its own shape (no black bars), scaled down to the quality's limit.
  const w = screen.width * devicePixelRatio, h = screen.height * devicePixelRatio;
  const scale = Math.min(1, quality.maxWidth / w, quality.maxHeight / h);
  const even = (n) => Math.max(2, Math.round(n * scale / 2) * 2);
  const desktop = { chromeMediaSource: 'desktop', chromeMediaSourceId: choice.id };
  const video = { mandatory: {
    ...desktop, minWidth: even(w), maxWidth: even(w), minHeight: even(h), maxHeight: even(h), maxFrameRate: 30
  } };
  let picture;
  try {
    picture = await navigator.mediaDevices.getUserMedia({ audio: choice.audio ? { mandatory: desktop } : false, video })
      .catch((e) => (choice.audio ? navigator.mediaDevices.getUserMedia({ audio: false, video }) : Promise.reject(e)));
  } catch (e) {
    return giveUp(`Couldn't record the screen: ${e.message}`);
  }

  // The computer's sound replaces the tab's: let the tab play normally again.
  // The tab's sound was muted by capturing it, so that one is played back.
  const computerSound = picture.getAudioTracks().length > 0;
  if (computerSound && sound) { sound.getTracks().forEach((t) => t.stop()); sound = null; }
  const audioIn = computerSound ? new MediaStream(picture.getAudioTracks()) : sound;
  const tracks = [...picture.getVideoTracks()];
  // Without the computer's sound, the other tabs send theirs (relaySound), so
  // the mix is set up even when the starting tab has no sound.
  if (ctx.state === 'running' && (audioIn || !computerSound)) {
    const gain = ctx.createGain();
    const out = ctx.createMediaStreamDestination();
    gain.connect(out);
    if (audioIn) {
      const input = ctx.createMediaStreamSource(audioIn);
      if (!computerSound) input.connect(ctx.destination);
      input.connect(gain);
    }
    fade = { ctx, gain };
    if (!computerSound) relayInto = fade;
    tracks.push(...out.stream.getAudioTracks());
  } else {
    // No sound, or the sound engine is still blocked: record the sound as is
    // (no fades) and play the tab's back with a plain audio element.
    ctx.close();
    if (audioIn) {
      if (!computerSound) {
        const player = new Audio();
        player.srcObject = audioIn;
        player.play().catch(() => {});
      }
      tracks.push(...audioIn.getAudioTracks());
    }
  }

  const mimeType = mimeCandidates('av', format).find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(new MediaStream(tracks), {
    mimeType,
    videoBitsPerSecond: videoBitrate(quality, picture.getVideoTracks()[0]),
    audioBitsPerSecond: quality.audioBitsPerSecond
  });
  send(() => ({ target: 'offscreen', type: 'element-start', rid, mimeType, title }));
  recorder.ondataavailable = (e) => {
    if (e.data.size) send(async () => ({ target: 'offscreen', type: 'element-chunk', rid, data: await blobToDataUrl(e.data) }));
  };
  recorder.onstop = async () => {
    endRelays();
    send(() => ({ target: 'offscreen', type: 'element-done', rid }));
    picture.getTracks().forEach((t) => t.stop());
    if (sound) sound.getTracks().forEach((t) => t.stop());
    if (fade) fade.ctx.close();
    await queue;
    closeWindow();
  };
  // Chrome's own "Stop sharing" button: stop and save like the popup's Stop.
  picture.getVideoTracks()[0].onended = () => chrome.runtime.sendMessage({ type: 'stop' });

  recorder.start(1000);
  const win = await chrome.windows.getCurrent();
  chrome.runtime.sendMessage({
    type: 'screen-started', rid, windowId: win.id,
    noSound: !tracks.some((t) => t.kind === 'audio'), computerSound
  });
  statusEl.textContent = 'Recording the screen… Use the extension\'s Stop button to stop.';
  // Keep this window out of the recording.
  chrome.windows.update(win.id, { state: 'minimized' });
}

start().catch((e) => fail(`Couldn't record the screen: ${e.message}`));
