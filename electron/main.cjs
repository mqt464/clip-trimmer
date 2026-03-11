const { randomUUID } = require("crypto");
const { app, BrowserWindow, dialog, ipcMain, protocol } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");
const ffmpegStaticPath = require("ffmpeg-static");
const ffprobeStaticPath = require("ffprobe-static").path;

const APP_BACKGROUND = "#0c0e11";
const MEDIA_SCHEME = "clip-media";
const OPENABLE_MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
let mainWindow = null;
let pendingOpenFilePath = null;
const mediaSessions = new Map();

function resolveBundledBinary(binaryName, developmentPath) {
  if (!app.isPackaged) {
    return developmentPath;
  }

  const extension = process.platform === "win32" ? ".exe" : "";
  const packagedPath = path.join(process.resourcesPath, "bin", `${binaryName}${extension}`);
  return fs.existsSync(packagedPath) ? packagedPath : developmentPath;
}

const ffmpegPath = resolveBundledBinary("ffmpeg", ffmpegStaticPath);
const ffprobePath = resolveBundledBinary("ffprobe", ffprobeStaticPath);

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function createMediaUrl(filePath) {
  return `${MEDIA_SCHEME}://local?path=${encodeURIComponent(filePath)}`;
}

function isOpenableMediaFile(filePath) {
  if (typeof filePath !== "string" || !filePath) {
    return false;
  }

  return OPENABLE_MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function findMediaFileInArgv(argv) {
  if (!Array.isArray(argv)) {
    return null;
  }

  for (const rawArg of argv) {
    if (typeof rawArg !== "string" || !rawArg || rawArg.startsWith("-")) {
      continue;
    }

    const candidatePath = path.resolve(rawArg);

    if (!isOpenableMediaFile(candidatePath)) {
      continue;
    }

    try {
      if (fs.statSync(candidatePath).isFile()) {
        return candidatePath;
      }
    } catch {
      // Ignore argv entries that do not point to a real file.
    }
  }

  return null;
}

function getMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".wav":
      return "audio/wav";
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".avi":
      return "video/x-msvideo";
    default:
      return "application/octet-stream";
  }
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader?.startsWith("bytes=")) {
    return null;
  }

  const [rawStart, rawEnd] = rangeHeader.replace("bytes=", "").split("-");
  const start = rawStart ? Number(rawStart) : 0;
  const end = rawEnd ? Number(rawEnd) : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= size) {
    return null;
  }

  return { start, end };
}

function registerMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const requestUrl = new URL(request.url);
    const requestedPath = requestUrl.searchParams.get("path");

    if (!requestedPath) {
      return new Response("Missing media path.", { status: 400 });
    }

    try {
      const fileStat = await fsp.stat(requestedPath);
      const range = parseRange(request.headers.get("range"), fileStat.size);
      const headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": getMimeType(requestedPath),
      };

      if (range) {
        const { start, end } = range;
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(requestedPath, { start, end });

        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            ...headers,
            "Content-Length": String(chunkSize),
            "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
          },
        });
      }

      const stream = fs.createReadStream(requestedPath);
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: {
          ...headers,
          "Content-Length": String(fileStat.size),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read media file.";
      return new Response(message, { status: 404 });
    }
  });
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

function flushPendingOpenFile() {
  if (!pendingOpenFilePath || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("video:open-request", pendingOpenFilePath);
  pendingOpenFilePath = null;
}

function queueOpenFile(filePath) {
  if (!isOpenableMediaFile(filePath)) {
    return;
  }

  pendingOpenFilePath = filePath;

  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) {
    flushPendingOpenFile();
  }
}

async function removeDirectory(directoryPath) {
  if (!directoryPath) {
    return;
  }

  try {
    await fsp.rm(directoryPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures for temp media artifacts.
  }
}

function createMediaSession(tempDir) {
  const sessionId = randomUUID();
  mediaSessions.set(sessionId, tempDir);
  return sessionId;
}

async function releaseMediaSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) {
    return;
  }

  const tempDir = mediaSessions.get(sessionId);

  if (!tempDir) {
    return;
  }

  mediaSessions.delete(sessionId);
  await removeDirectory(tempDir);
}

async function releaseAllMediaSessions() {
  const releaseTasks = [];

  for (const sessionId of mediaSessions.keys()) {
    releaseTasks.push(releaseMediaSession(sessionId));
  }

  await Promise.all(releaseTasks);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: APP_BACKGROUND,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const sendWindowState = () => {
    if (mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.webContents.send("window:state-changed", {
      isMaximized: mainWindow.isMaximized(),
    });
  };

  mainWindow.on("maximize", sendWindowState);
  mainWindow.on("unmaximize", sendWindowState);
  mainWindow.on("ready-to-show", sendWindowState);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("did-finish-load", flushPendingOpenFile);

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function runProcess(command, args, options = {}) {
  const { encoding = "utf8" } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();

      if (code !== 0) {
        reject(new Error(stderrText || `${command} exited with code ${code}`));
        return;
      }

      const output = Buffer.concat(stdout);
      resolve(encoding === "buffer" ? output : output.toString("utf8"));
    });
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseTimestampToSeconds(value) {
  if (typeof value !== "string" || !value) {
    return 0;
  }

  const [hoursPart, minutesPart, secondsPart] = value.split(":");
  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  const seconds = Number(secondsPart);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return 0;
  }

  return hours * 3600 + minutes * 60 + seconds;
}

function parseProgressSpeed(value) {
  if (typeof value !== "string") {
    return null;
  }

  const numeric = Number.parseFloat(value.replace("x", "").trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function emitExportProgress(webContents, progress) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.send("video:export-progress", progress);
}

function parseFrameRate(rate) {
  if (!rate || rate === "0/0") {
    return 30;
  }

  const [numerator, denominator] = rate.split("/").map(Number);

  if (!numerator || !denominator) {
    return 30;
  }

  return numerator / denominator;
}

function formatAudioLabel(stream, audioIndex) {
  const pieces = [`Track ${audioIndex + 1}`];

  if (stream.tags?.title) {
    pieces.push(stream.tags.title);
  } else if (stream.tags?.language) {
    pieces.push(stream.tags.language.toUpperCase());
  }

  if (stream.channels) {
    pieces.push(`${stream.channels}ch`);
  }

  return pieces.join(" / ");
}

async function probeMedia(filePath) {
  const fileStat = await fsp.stat(filePath);
  const output = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,channels:stream_tags=language,title",
    "-of",
    "json",
    filePath,
  ]);

  const data = JSON.parse(output);
  const streams = data.streams || [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");

  if (!videoStream) {
    throw new Error("This file does not contain a video stream.");
  }

  const audioTracks = streams
    .filter((stream) => stream.codec_type === "audio")
    .map((stream, audioIndex) => ({
      id: `audio-${audioIndex}`,
      audioIndex,
      sourceIndex: stream.index,
      label: formatAudioLabel(stream, audioIndex),
      channels: stream.channels || 2,
      codecName: stream.codec_name || "audio",
      language: stream.tags?.language || null,
      title: stream.tags?.title || null,
    }));

  return {
    filePath,
    fileUrl: createMediaUrl(filePath),
    fileName: path.basename(filePath),
    fileSizeBytes: fileStat.size,
    duration: Number(data.format?.duration || 0),
    fps: parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    width: videoStream.width || 1920,
    height: videoStream.height || 1080,
    audioTracks,
  };
}

async function createThumbnail(filePath, timeSeconds, width = 224, height = 126) {
  const imageBuffer = await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      timeSeconds.toFixed(3),
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x0d1014`,
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );

  return `data:image/png;base64,${imageBuffer.toString("base64")}`;
}

async function generateThumbnails(filePath, duration) {
  const thumbCount = clamp(Math.round(duration / 8), 8, 18);
  const interval = duration > 0 ? duration / thumbCount : 0;
  const thumbnails = [];

  for (let index = 0; index < thumbCount; index += 1) {
    const timeSeconds = duration > 0 ? Math.min(duration, interval * index + interval * 0.45) : 0;
    thumbnails.push(await createThumbnail(filePath, timeSeconds));
  }

  return thumbnails;
}

async function extractAudioTrack(filePath, sourceIndex, outputPath) {
  await runProcess(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    filePath,
    "-map",
    `0:${sourceIndex}`,
    "-vn",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-acodec",
    "pcm_s16le",
    outputPath,
  ]);

  return outputPath;
}

function normalizeWaveform(samples, bucketCount) {
  if (!samples.length || !bucketCount) {
    return [];
  }

  const bucketSize = Math.max(1, Math.floor(samples.length / bucketCount));
  const buckets = [];

  for (let index = 0; index < bucketCount; index += 1) {
    const start = index * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(samples[sampleIndex]));
    }

    buckets.push(Number(Math.min(1, peak).toFixed(4)));
  }

  return buckets;
}

function downsampleWaveform(samples, bucketCount) {
  if (!samples.length) {
    return [];
  }

  if (bucketCount >= samples.length) {
    return samples.slice();
  }

  const buckets = [];
  const step = samples.length / bucketCount;

  for (let index = 0; index < bucketCount; index += 1) {
    const start = Math.floor(index * step);
    const end = Math.max(start + 1, Math.floor((index + 1) * step));
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(samples[sampleIndex] || 0));
    }

    buckets.push(Number(Math.min(1, peak).toFixed(4)));
  }

  return buckets;
}

function buildWaveformLevels(baseSamples) {
  const requestedLevels = [256, 512, 1024, 2048, 4096, 8192];
  const levels = requestedLevels
    .filter((bucketCount) => bucketCount < baseSamples.length)
    .map((bucketCount) => ({
      bucketCount,
      samples: downsampleWaveform(baseSamples, bucketCount),
    }));

  levels.push({
    bucketCount: baseSamples.length,
    samples: baseSamples,
  });

  return levels;
}

async function generateWaveform(filePath, sourceIndex, duration) {
  const sampleRate = clamp(Math.round(48000 / Math.max(duration, 1)), 240, 3200);
  const rawBuffer = await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-map",
      `0:${sourceIndex}`,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );

  const floatArray = new Float32Array(
    rawBuffer.buffer,
    rawBuffer.byteOffset,
    Math.floor(rawBuffer.byteLength / 4),
  );

  const bucketCount = clamp(Math.round(duration * 140), 1400, 4800);
  const baseSamples = normalizeWaveform(Array.from(floatArray), bucketCount);

  return {
    samples: baseSamples,
    waveformLevels: buildWaveformLevels(baseSamples),
  };
}

async function analyzeMedia(filePath) {
  const media = await probeMedia(filePath);
  const thumbnails = await generateThumbnails(filePath, media.duration);

  if (!media.audioTracks.length) {
    return {
      ...media,
      sessionId: null,
      thumbnails,
      audioTracks: [],
    };
  }

  const tempDir = await fsp.mkdtemp(path.join(app.getPath("temp"), "clip-trimmer-"));

  try {
    const audioTracks = await Promise.all(
      media.audioTracks.map(async (track) => {
        const audioOutputPath = path.join(tempDir, `${track.id}.wav`);
        const [waveform, extractedPath] = await Promise.all([
          generateWaveform(filePath, track.sourceIndex, media.duration),
          extractAudioTrack(filePath, track.sourceIndex, audioOutputPath),
        ]);

        return {
          ...track,
          audioUrl: createMediaUrl(extractedPath),
          volume: 1,
          ...waveform,
        };
      }),
    );

    return {
      ...media,
      sessionId: createMediaSession(tempDir),
      thumbnails,
      audioTracks,
    };
  } catch (error) {
    await removeDirectory(tempDir);
    throw error;
  }
}

async function exportClip(webContents, { sourcePath, fileName, startTime, endTime, trackVolumes }) {
  const sourceParsed = path.parse(sourcePath);
  const parsed = fileName
    ? {
        ...sourceParsed,
        name: path.parse(fileName).name || sourceParsed.name,
      }
    : sourceParsed;
  const defaultPath = path.join(parsed.dir, `${parsed.name}-trimmed.mp4`);
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export Trimmed Clip",
    defaultPath,
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });

  if (canceled || !filePath) {
    return { canceled: true };
  }

  const duration = Math.max(0.04, endTime - startTime);
  const volumeEntries = Array.isArray(trackVolumes) ? trackVolumes : [];
  const audibleEntries = volumeEntries.filter(
    (entry) => Number.isFinite(entry.audioIndex) && Number.isFinite(entry.volume) && entry.volume > 0.0001,
  );
  const hasAudio = audibleEntries.length > 0;
  const args = [
    "-hide_banner",
    "-y",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-i",
    sourcePath,
    "-ss",
    startTime.toFixed(3),
    "-t",
    duration.toFixed(3),
  ];

  if (hasAudio) {
    const audioFilterChains = audibleEntries.map(
      (entry, index) =>
        `[0:a:${entry.audioIndex}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${clamp(entry.volume, 0, 2).toFixed(3)}[a${index}]`,
    );
    const audioOutputLabel =
      audibleEntries.length === 1
        ? "[a0]"
        : "[amixout]";

    if (audibleEntries.length > 1) {
      audioFilterChains.push(
        `${audibleEntries.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audibleEntries.length}:normalize=0:dropout_transition=0[amixout]`,
      );
    }

    args.push("-filter_complex", audioFilterChains.join(";"), "-map", "0:v:0?", "-map", audioOutputLabel);
  } else {
    args.push("-map", "0:v:0?");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
  );

  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }

  args.push(filePath);
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    const progressState = {};
    let stdoutBuffer = "";

    const flushProgressLine = (line) => {
      const trimmed = line.trim();

      if (!trimmed || !trimmed.includes("=")) {
        return;
      }

      const [rawKey, ...rawValue] = trimmed.split("=");
      const key = rawKey.trim();
      const value = rawValue.join("=").trim();
      progressState[key] = value;

      if (key !== "progress") {
        return;
      }

      const processedSeconds = clamp(
        parseTimestampToSeconds(progressState.out_time) ||
          Number(progressState.out_time_us || progressState.out_time_ms || 0) / 1000000,
        0,
        duration,
      );
      const progress = duration > 0 ? clamp(processedSeconds / duration, 0, 1) : 0;
      const speed = parseProgressSpeed(progressState.speed);
      const remainingSeconds = Math.max(0, duration - processedSeconds);
      const etaSeconds = speed ? remainingSeconds / speed : null;

      emitExportProgress(webContents, {
        progress: value === "end" ? 1 : progress,
        processedSeconds: value === "end" ? duration : processedSeconds,
        totalSeconds: duration,
        etaSeconds: value === "end" ? 0 : etaSeconds,
        speed,
      });

      Object.keys(progressState).forEach((stateKey) => {
        delete progressState[stateKey];
      });
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach(flushProgressLine);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (stdoutBuffer) {
        flushProgressLine(stdoutBuffer);
      }

      const stderrText = Buffer.concat(stderr).toString("utf8").trim();

      if (code !== 0) {
        reject(new Error(stderrText || `${ffmpegPath} exited with code ${code}`));
        return;
      }

      resolve();
    });
  });
  return { canceled: false, outputPath: filePath };
}

ipcMain.handle("video:open", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Open Video",
    properties: ["openFile"],
    filters: [
      {
        name: "Video Files",
        extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v"],
      },
    ],
  });

  if (canceled || !filePaths.length) {
    return null;
  }

  return analyzeMedia(filePaths[0]);
});

ipcMain.handle("video:analyze", async (_event, filePath) => analyzeMedia(filePath));
ipcMain.handle("video:export", async (event, payload) => exportClip(event.sender, payload));
ipcMain.handle("video:release-media-session", async (_event, sessionId) => {
  await releaseMediaSession(sessionId);
});
ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.handle("window:toggle-maximize", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window) {
    return { isMaximized: false };
  }

  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }

  return { isMaximized: window.isMaximized() };
});
ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("window:get-state", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return {
    isMaximized: window?.isMaximized() ?? false,
  };
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const filePath = findMediaFileInArgv(argv);

    focusMainWindow();

    if (filePath) {
      queueOpenFile(filePath);
    }
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    queueOpenFile(filePath);
    focusMainWindow();
  });

  app.whenReady().then(() => {
    registerMediaProtocol();
    createWindow();

    const launchFilePath = findMediaFileInArgv(process.argv.slice(1));

    if (launchFilePath) {
      queueOpenFile(launchFilePath);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        flushPendingOpenFile();
      } else {
        focusMainWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  void releaseAllMediaSessions();
});
