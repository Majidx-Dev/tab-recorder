# Tab Recorder

A Chrome extension (version 1.0) that records the video and sound playing in
your browser and saves them as a file. You can record just the video, the
whole tab, or the whole screen. It records what plays; it does not download
the stream.

Works in Chrome and other Chromium browsers (Edge, Brave, Opera).

## Install or update

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `tab-recorder` folder.
4. Pin the extension from the puzzle-piece menu.

To update, replace the files in this folder and press the **Reload** (↻)
button on the extension's card. Your settings are kept. Refresh tabs that were
already open, so the new version can work in them.

## Recording

1. Go to the tab with the video or audio.
2. Click the Tab Recorder icon.
3. Under **What to record**, pick one:
   - **Only the video**: the player alone (default).
   - **Whole tab**: everything the tab shows.
   - **Whole screen**: the whole screen, across all tabs and apps.
4. Click **Record video + audio** or **Record audio only**.

While recording, the popup shows **Recording**, the time recorded (paused time
not counted), and what is being recorded. The icon shows a red `REC` badge, or
a grey `II` while paused. The popup updates live, even if it stays open.

- **Pause / Resume**: pauses the recording and the video on the page; Resume
  continues both.
- **Stop & save**: ends the recording. The popup shows **Saving…**, then
  **Ready**, and Chrome's Save As window opens.

With **Only the video** or **Whole tab**, closing the recorded tab also stops
and saves the recording.

## The three sources

### Only the video

Records the page's main video (or audio) element itself, at the video's own
size. The page around it and the player's controls are not in the file. If the
page has no video, or the video can't be recorded this way (DRM, some embedded
players), it records the whole tab instead and the popup says so.

### Whole tab

Records everything the tab shows, at the tab's own shape, so the file has no
black bars. If you resize the window or go fullscreen while recording, bars can
appear for that part. Use it for games, canvas or 3D players, sites that make
sound with Web Audio, or meetings with several videos.

### Whole screen

Records the whole screen: the browser's tabs and address bar, the
taskbar/dock, other apps, everything you see. It keeps recording while you
switch tabs or apps, until you stop it.

1. Click **Record video + audio**. A small Tab Recorder window opens.
2. Click **Start recording** in it. Chrome only turns the sound on after a
   click in that window.
3. Pick your screen in Chrome's chooser and press **Share**. Chrome always
   asks this for screen recording; it can't be skipped.

The small window then minimizes itself, so it isn't in the recording. Stop with
the popup's **Stop & save**, Chrome's **Stop sharing** bar, or by closing the
small window.

**Sound in Whole screen**

- **Share system audio**: if Chrome's chooser offers this (Windows, ChromeOS,
  some Linux setups) and you tick it, the computer's own sound is recorded:
  every tab and app.
- **Otherwise**, nothing to set up: the sound of the tab you started from is
  recorded, and every other tab sends the sound of the video or audio playing
  in it. This is done with WebRTC inside the browser, and the tabs keep
  playing normally. Tabs opened or loaded during the recording are included.

**Record audio only** with Whole screen records the starting tab's sound, like
Whole tab.

## Following the video (always on)

These work automatically; there are no switches for them.

- **Play from the beginning**: when recording starts, the video on the page is
  rewound to 0:00 and played, so nothing is cut off. Live streams keep playing
  from where they are.
- **Pause and resume with the video**: pausing the video in its own player
  (button, Space, click) pauses the recording, and playing it resumes the
  recording. Buffering, seeking and scrolling to the next video in a feed
  (TikTok, Shorts, Reels) don't pause it.
- **Save when the video ends**: when the video plays to the end (or a looping
  video starts over), the recording stops and Save As opens. With **Only the
  video**, moving on to another video also saves the previous one.

In **Whole screen** the recording follows the videos in every tab. It pauses
when you pause what is playing and nothing else plays, and resumes as soon as
anything plays. A video that a site pauses because you switched away from its
tab doesn't pause the recording. A video ending doesn't stop it.

Pauses don't show in the file: the recording stops the moment the video stops
(before the player draws its pause icon), restarts only once the video is
really playing again, and the sound fades over a few milliseconds so the join
doesn't click. In **Whole tab** mode, anything else the page shows while you
pause (such as player controls on hover) can appear for a frame.

## File options

Open **File options** at the bottom of the popup. When it is closed, its row
shows the current settings, for example `WebM · High · Recordings`.

- **Format**:
  - **WebM** (default): VP8 video and Opus sound; audio-only files are `.webm`.
    Plays in VLC, Chrome and mpv.
  - **MP4**: H.264 video; audio-only files are `.m4a`. Where Chrome can make
    AAC sound (Windows, Mac) the sound is AAC. Elsewhere (such as Linux) it is
    Opus. Chrome's Opus MP4 normally ticks every few seconds; the extension
    fixes the sound timing when saving, so it plays smoothly. Nothing is
    re-encoded.
- **Quality**: **Low** (480p, small files), **Medium** (720p) or **High**
  (default, 1080p). High gives big and 60 fps videos (1080p60, 4K) more
  bitrate, so the recording looks like the original. With **Only the video**
  the picture keeps the video's own size and the quality sets the bitrate.
- **Save in folder**: a folder inside Downloads, such as `Recordings`. It is
  created if needed. Leave it empty to save straight into Downloads.

## Saving

When a recording ends, Chrome's **Save As** window opens in Downloads (or the
**Save in folder** folder) with the name filled in: the tab's title and the
date and time.

- **Save**: keeps the file. You can change the name or the place first.
- **Cancel** or close the window: the recording is thrown away.

## Notes

- Recording happens in real time: a 10-minute video takes 10 minutes to record.
- While recording, every second is written to disk (the extension's own
  storage), not kept in memory, so long recordings don't fill up RAM. At Save,
  the file is copied to where you chose and removed from that storage. A very
  long recording can take a few seconds to appear. Keep enough free disk space.
- Video is recorded at up to 30 frames per second in VP8 or H.264, which an
  ordinary laptop can keep up with at 1080p, so recordings play smoothly.
- DRM-protected services (Netflix, Prime Video and others) show a black picture
  in any recording.
- `chrome://` pages and the Chrome Web Store can't be recorded.
- Black bars on the sides when you play a file usually come from the player's
  window shape, not the file. Play it fullscreen.

## Permissions

| Permission | Used for |
|---|---|
| `tabCapture` | Recording a tab's picture and sound |
| `desktopCapture` | Recording the whole screen |
| `offscreen` | The hidden page that records and saves |
| `scripting`, all sites | Finding the video on the page, following its pause/play, and picking up other tabs' sound in Whole screen |
| `activeTab` | Recording the tab you clicked the icon on |
| `downloads` | Saving the file |
| `storage`, `unlimitedStorage` | Your settings, and writing long recordings to disk |

## Files

| File | What it does |
|---|---|
| `manifest.json` | The extension's definition |
| `popup.html`, `popup.js` | The toolbar popup |
| `background.js` | Starts and stops recordings, follows videos, saves files |
| `offscreen.html`, `offscreen.js` | Records the whole tab; collects and saves every recording |
| `element-recorder.js` | Runs in the page: records **Only the video**, follows pause/play/end |
| `screen.html`, `screen.js` | The small window that records the **Whole screen** |
| `tab-sound.js` | Runs in other tabs during **Whole screen** and sends their sound |
| `recording-file.js` | File formats, and fixes to the file's length and MP4 sound timing |
