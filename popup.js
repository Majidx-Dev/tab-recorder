const statusEl = document.getElementById('status');
const noteEl = document.getElementById('note');
const errorEl = document.getElementById('error');
const startAV = document.getElementById('startAV');
const startA = document.getElementById('startA');
const stopBtn = document.getElementById('stop');
const pauseBtn = document.getElementById('pause');
const sourceRow = document.getElementById('sourceRow');
const moreRow = document.getElementById('moreRow');
const timerEl = document.getElementById('timer');
const subEl = document.getElementById('sub');
const fileSummary = document.getElementById('fileSummary');
const sourceRadios = document.querySelectorAll('input[name="source"]');
const formatRadios = document.querySelectorAll('input[name="format"]');
const qualitySelect = document.getElementById('quality');
const folderInput = document.getElementById('folder');
let timer;

chrome.storage.local.get('source').then(({ source }) => {
  for (const r of sourceRadios) if (r.value === source) r.checked = true;
});
for (const r of sourceRadios) r.onchange = () => chrome.storage.local.set({ source: r.value });
chrome.storage.local.get(['format', 'quality', 'folder']).then((o) => {
  for (const r of formatRadios) if (r.value === o.format) r.checked = true;
  if (o.quality) qualitySelect.value = o.quality;
  if (o.folder !== undefined) folderInput.value = o.folder;
  showFileSummary();
});
for (const r of formatRadios) r.onchange = () => chrome.storage.local.set({ format: r.value });
qualitySelect.onchange = () => chrome.storage.local.set({ quality: qualitySelect.value });

folderInput.oninput = () => { chrome.storage.local.set({ folder: folderInput.value }); showFileSummary(); };

// The closed File options row shows what is set, so it needn't be opened to check.
function showFileSummary() {
  const format = document.querySelector('input[name="format"]:checked').value === 'mp4' ? 'MP4' : 'WebM';
  const quality = qualitySelect.options[qualitySelect.selectedIndex].text.replace(/ \(.*\)/, '');
  const folder = folderInput.value.trim();
  fileSummary.textContent = [format, quality, folder].filter(Boolean).join(' · ');
}
for (const r of formatRadios) r.addEventListener('change', showFileSummary);
qualitySelect.addEventListener('change', showFileSummary);

// While idle, the caption names the tab that will be recorded.
let tabTitle = '';
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  tabTitle = (tab && tab.title) || '';
  if (document.body.dataset.state === 'idle') subEl.textContent = tabTitle;
});

const selectedSource = () => document.querySelector('input[name="source"]:checked').value;

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'get-state' });
  const rec = state && state.recording;
  startAV.classList.toggle('hidden', rec);
  startA.classList.toggle('hidden', rec);
  sourceRow.classList.toggle('hidden', rec);
  moreRow.classList.toggle('hidden', rec);
  stopBtn.classList.toggle('hidden', !rec);
  pauseBtn.classList.toggle('hidden', !rec || !!state.stopping);
  stopBtn.disabled = !!(rec && state.stopping);
  pauseBtn.querySelector('span').textContent = rec && state.paused ? 'Resume' : 'Pause';
  document.body.dataset.state = rec ? (state.paused ? 'paused' : 'recording') : 'idle';
  noteEl.textContent = rec && state.note ? state.note : '';
  clearInterval(timer);
  if (rec) {
    const what = state.mode === 'av' ? 'video + audio' : 'audio';
    const where = { video: 'only the video', tab: 'whole tab', screen: 'whole screen' }[state.source];
    const tick = () => {
      if (state.stopping) {
        statusEl.textContent = 'Saving…';
        return;
      }
      // Recorded time only: paused stretches don't count.
      const now = state.paused ? state.pausedAt : Date.now();
      const s = Math.floor((now - state.startedAt - (state.pausedTotal || 0)) / 1000);
      const t = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      statusEl.textContent = state.paused ? 'Paused' : 'Recording';
      timerEl.textContent = t;
      subEl.textContent = `${what[0].toUpperCase()}${what.slice(1)} · ${where}`;
    };
    tick();
    timer = setInterval(tick, 1000);
  } else {
    statusEl.textContent = 'Ready';
    timerEl.textContent = '';
    subEl.textContent = tabTitle;
    if (state && state.error) errorEl.textContent = state.error;
  }
}

async function start(mode) {
  errorEl.textContent = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Always get a tab-capture stream id: "Only the video" falls back to it if
    // the page's video can't be recorded directly.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({
      type: 'start', streamId, mode, title: tab.title || 'recording', tabId: tab.id,
      source: selectedSource(),
      // Always on (no checkboxes): play from the beginning, pause/resume with
      // the video, save when the video ends.
      restart: true, autoPause: true, autoSave: true,
      format: document.querySelector('input[name="format"]:checked').value, quality: qualitySelect.value
    });
    if (!res || !res.ok) throw new Error(res ? res.error : 'Failed to start');
  } catch (e) {
    errorEl.textContent = e.message;
  }
  refresh();
}

startAV.onclick = () => start('av');
startA.onclick = () => start('audio');
pauseBtn.onclick = async () => {
  const state = await chrome.runtime.sendMessage({ type: 'get-state' });
  await chrome.runtime.sendMessage({ type: state && state.paused ? 'resume' : 'pause' });
  refresh();
};
stopBtn.onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  setTimeout(refresh, 300);
};

// Keep an open popup in step with the recording: when the video ends and the
// recording stops on its own (or is saving), show it at once instead of a
// stale "Recording" with a running timer.
chrome.storage.session.onChanged.addListener((changes) => { if (changes.state) refresh(); });

refresh();
