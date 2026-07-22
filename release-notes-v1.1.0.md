# Clip Trimmer 1.1.0

## Changes

- Added asynchronous media asset preparation so clips open before thumbnails and audio waveforms finish processing.
- Added session-scoped media URLs, path validation, job cancellation, and cleanup for safer file loading.
- Added a settings popover with persisted timeline expansion, precise export, and tooltip preferences.
- Added precise export mode, export validation, and a compatibility fallback for difficult FFmpeg outputs.
- Improved audio track timing, playback offsets, waveform rendering, and muted-track export handling.
- Added Windows app icon and development app identity handling.
- Added ESLint, Vitest, Electron type checking, and targeted media utility tests.

## Verification

- `npm run check`
- `npm run release:win`
