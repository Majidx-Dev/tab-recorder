// Injected into the other tabs while "Whole screen" records (see screen.js).
// Chrome only lets an extension take a tab's sound from the tab it was
// started on, and on many computers it won't share the computer's sound. So
// each video/audio that plays in another tab sends its own sound to the
// recording window over WebRTC (a direct connection inside the browser), which
// mixes it into the recording. The page keeps playing normally.
(() => {
  if (window.__tabRecorderSound) { window.__tabRecorderSound.resume(); return; }
  const links = new Map();  // id -> { pc, el }
  const shared = new WeakSet();
  let active = true;

  const send = (msg) => chrome.runtime.sendMessage({ ...msg, target: 'screen' }).catch(() => {});

  async function share(el) {
    if (!active || shared.has(el) || el.paused || el.muted || el.volume === 0) return;
    let stream;
    try {
      stream = el.captureStream();  // throws for DRM-protected or cross-origin media
    } catch {
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    shared.add(el);
    const id = Math.random().toString(36).slice(2);
    const pc = new RTCPeerConnection();
    links.set(id, { pc, el });
    const forget = () => { links.delete(id); shared.delete(el); pc.close(); };
    // A new video in the same player ends the old sound: share again on 'playing'.
    track.onended = forget;
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') forget(); };
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'snd-ice', id, candidate: e.candidate.toJSON() }); };
    pc.addTrack(track, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'snd-offer', id, sdp: offer.sdp });
  }

  const onMedia = (e) => { if (e.target instanceof HTMLMediaElement) share(e.target); };
  // 'volumechange': feeds like TikTok start muted and are unmuted by the user.
  for (const type of ['playing', 'volumechange']) document.addEventListener(type, onMedia, true);

  chrome.runtime.onMessage.addListener((msg) => {
    const link = links.get(msg.id);
    if (msg.type === 'snd-answer' && link) link.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
    if (msg.type === 'snd-ice' && link) link.pc.addIceCandidate(msg.candidate).catch(() => {});
    if (msg.type === 'snd-stop') {
      active = false;
      for (const { pc } of links.values()) pc.close();
      links.clear();
    }
  });

  window.__tabRecorderSound = {
    // (Re)start sharing: what is already playing now, then whatever plays later.
    resume() {
      active = true;
      for (const m of document.querySelectorAll('video, audio')) share(m);
    }
  };
  window.__tabRecorderSound.resume();
})();
