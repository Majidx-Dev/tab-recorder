# Changelog

## 1.0 — 2026-11-11

First release.

### Recording
- Three sources: **Only the video** (the player alone, at the video's own size),
  **Whole tab** (at the tab's own shape, no black bars) and **Whole screen**
  (every tab and app).
- Record video + audio, or audio only.
- Pause / Resume from the popup, with joins that don't show or click in the file.
- Whole screen keeps recording across tabs, and picks up the sound of videos
  playing in other tabs with no setup (or the computer's sound when Chrome
  offers "Share system audio").

### Follows the video (always on)
- Starts the video from the beginning when recording starts.
- Pauses and resumes the recording with the video, including in feeds such as
  TikTok, Shorts and Reels; in Whole screen, across all tabs.
- Saves when the video ends (Only the video, Whole tab).

### Files
- WebM (VP8 + Opus) or MP4 (H.264; AAC sound where Chrome can make it,
  otherwise Opus with its timing fixed so it doesn't tick).
- Quality: Low, Medium or High (more bitrate for big or 60 fps videos).
- Save in a folder inside Downloads.
- Save As window every time; Cancel throws the recording away.
- Long recordings are written to disk while recording, not kept in RAM.
- Files carry their length, so players show it and can seek.

### Popup
- New "Instant Print" design, light and dark, following the system theme.
- Shows what is recording, the time, and Saving… / Ready, updating live.
