# Clip Trimmer

Clip Trimmer is a lightweight Electron desktop app for trimming video clips and mixing multiple embedded audio tracks before export.

## Features

- Open common video formats including `mp4`, `mov`, `mkv`, `avi`, `webm`, and `m4v`
- Drag trim handles on a visual timeline with thumbnail previews
- Inspect and rebalance each audio track independently
- Export the selected range to a new H.264/AAC MP4 file
- Launch the app by opening a supported video file directly

## Development

Install dependencies and start the app in development mode:

```bash
npm install
npm run dev
```

Create the renderer build only:

```bash
npm run build
```

## Windows Installer

Build the Windows NSIS installer:

```bash
npm run dist
```

The compiled installer is written to:

```text
release/Clip Trimmer-Setup-1.1.0.exe
```

The packaged app bundles `ffmpeg` and `ffprobe`, so trimming and export work in the installed build without requiring a separate system install.

## Release 1.1.0

Version `1.1.0` is intended to ship as a GitHub release with the compiled Windows setup attached.

Changes in this release:

- Added asynchronous media asset preparation so clips open before thumbnails and audio waveforms finish processing.
- Added session-scoped media URLs, path validation, job cancellation, and cleanup for safer file loading.
- Added a settings popover with persisted timeline expansion, precise export, and tooltip preferences.
- Added precise export mode, export validation, and a compatibility fallback for difficult FFmpeg outputs.
- Improved audio track timing, playback offsets, waveform rendering, and muted-track export handling.
- Added Windows app icon and development app identity handling.
- Added ESLint, Vitest, Electron type checking, and targeted media utility tests.

Typical release flow:

```bash
git tag v1.1.0
git push origin main
git push origin v1.1.0
gh release create v1.1.0 release/Clip\ Trimmer-Setup-1.1.0.exe --title "Clip Trimmer 1.1.0" --notes-file release-notes-v1.1.0.md
```
