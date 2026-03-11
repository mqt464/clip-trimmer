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
release/Clip Trimmer-Setup-1.0.0.exe
```

The packaged app bundles `ffmpeg` and `ffprobe`, so trimming and export work in the installed build without requiring a separate system install.

## Release 1.0.0

Version `1.0.0` is intended to ship as a GitHub release with the compiled Windows setup attached.

Typical release flow:

```bash
git tag v1.0.0
git push origin master
git push origin v1.0.0
gh release create v1.0.0 release/Clip\ Trimmer-Setup-1.0.0.exe --title "Clip Trimmer 1.0.0" --notes "Initial 1.0.0 release."
```
