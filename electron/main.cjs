const { randomUUID } = require("crypto");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");
const ffmpegStaticPath = require("ffmpeg-static");
const ffprobeStaticPath = require("ffprobe-static").path;
const {
  buildExportArgs,
  buildWaveformLevels,
  clamp,
  formatAudioLabel,
  isOpenableMediaExtension,
  normalizeWaveform,
  parseFrameRate,
  parseProgressSpeed,
  parseTimestampToSeconds,
} = require("./media-utils.cjs");

const IS_DEV = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_ID = IS_DEV ? "com.mqt464.cliptrimmer.dev" : "com.mqt464.cliptrimmer";
const APP_NAME = IS_DEV ? "Clip Trimmer Dev" : "Clip Trimmer";
const APP_BACKGROUND = "#0c0e11";
const APP_ICON_PATHS = IS_DEV
  ? [
      path.join(__dirname, "..", "build", "icon.png"),
      path.join(__dirname, "..", "build", "icon.ico"),
    ]
  : [path.join(process.resourcesPath, "icon.ico")];
const MEDIA_SCHEME = "clip-media";
let mainWindow = null;
let pendingOpenFilePath = null;
const mediaSessions = new Map();

function getAppIcon() {
  for (const iconPath of APP_ICON_PATHS) {
    if (!fs.existsSync(iconPath)) {
      continue;
    }

    const icon = nativeImage.createFromPath(iconPath);

    if (!icon.isEmpty()) {
      return icon;
    }
  }

  return undefined;
}

function logDevAppIdentity() {
  if (!IS_DEV) {
    return;
  }

  const availableIconPath = APP_ICON_PATHS.find((iconPath) => fs.existsSync(iconPath)) || "none";
  console.info(`[Clip Trimmer] dev AppUserModelID=${APP_ID}; icon=${availableIconPath}`);
}

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

function createMediaUrl(sessionId, assetId) {
  return `${MEDIA_SCHEME}://${sessionId}/${encodeURIComponent(assetId)}`;
}

function isOpenableMediaFile(filePath) {
  if (typeof filePath !== "string" || !filePath) {
    return false;
  }

  return isOpenableMediaExtension(path.extname(filePath));
}

async function validateOpenableMediaPath(filePath) {
  if (!isOpenableMediaFile(filePath)) {
    throw new Error("Unsupported video file type.");
  }

  const resolvedPath = path.resolve(filePath);
  const fileStat = await fsp.stat(resolvedPath);

  if (!fileStat.isFile()) {
    throw new Error("Selected path is not a file.");
  }

  return resolvedPath;
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
    const sessionId = requestUrl.hostname;
    const assetId = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
    const session = mediaSessions.get(sessionId);

    if (!session || session.released || !assetId) {
      return new Response("Unknown media session.", { status: 404 });
    }

    const requestedPath = assetId === "source" ? session.sourcePath : session.assets.get(assetId);

    if (!requestedPath) {
      return new Response("Unknown media asset.", { status: 404 });
    }

    try {
      const fileStat = await fsp.stat(requestedPath);

      if (!fileStat.isFile()) {
        return new Response("Media asset is not a file.", { status: 404 });
      }

      const range = parseRange(request.headers.get("range"), fileStat.size);
      const headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": getMimeType(requestedPath),
      };

      if (range) {
        const { start, end } = range;
        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(requestedPath, { start, end });
        const body = /** @type {BodyInit} */ (Readable.toWeb(stream));

        return new Response(body, {
          status: 206,
          headers: {
            ...headers,
            "Content-Length": String(chunkSize),
            "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
          },
        });
      }

      const stream = fs.createReadStream(requestedPath);
      const body = /** @type {BodyInit} */ (Readable.toWeb(stream));
      return new Response(body, {
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

function stopSessionJobs(session) {
  if (!session) {
    return;
  }

  session.cancelled = true;
  session.jobs.forEach((child) => {
    if (!child.killed) {
      child.kill();
    }
  });
  session.jobs.clear();
}

function createMediaSession(sourcePath, tempDir, audioTracks) {
  const sessionId = randomUUID();
  mediaSessions.set(sessionId, {
    assets: new Map(),
    audioTracks,
    cancelled: false,
    jobs: new Set(),
    released: false,
    sessionId,
    sourcePath,
    tempDir,
  });
  return sessionId;
}

async function releaseMediaSession(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) {
    return;
  }

  const session = mediaSessions.get(sessionId);

  if (!session) {
    return;
  }

  session.released = true;
  stopSessionJobs(session);
  mediaSessions.delete(sessionId);
  await removeDirectory(session.tempDir);
}

async function releaseAllMediaSessions() {
  const releaseTasks = [];

  for (const sessionId of mediaSessions.keys()) {
    releaseTasks.push(releaseMediaSession(sessionId));
  }

  await Promise.all(releaseTasks);
}

function createWindow() {
  const appIcon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: APP_BACKGROUND,
    frame: false,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (appIcon && process.platform === "win32") {
    mainWindow.setIcon(appIcon);
  }

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
  const { encoding = "utf8", session = null } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (session) {
      if (session.cancelled || session.released) {
        child.kill();
        reject(new Error("Media processing was cancelled."));
        return;
      }

      session.jobs.add(child);
    }

    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      session?.jobs.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      session?.jobs.delete(child);

      if (session?.cancelled || session?.released) {
        reject(new Error("Media processing was cancelled."));
        return;
      }

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

function emitExportProgress(webContents, progress) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.send("video:export-progress", progress);
}

async function probeMedia(filePath) {
  const fileStat = await fsp.stat(filePath);
  const output = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,channels,start_time,duration:stream_tags=language,title",
    "-of",
    "json",
    filePath,
  ]);

  const data = JSON.parse(output);
  const streams = data.streams || [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const mediaDuration = Number(data.format?.duration || 0);

  if (!videoStream) {
    throw new Error("This file does not contain a video stream.");
  }

  const audioTracks = streams
    .filter((stream) => stream.codec_type === "audio")
    .map((stream, audioIndex) => {
      const startTime = Math.max(0, Number(stream.start_time || 0));
      const streamDuration = Number(stream.duration);
      const duration = Number.isFinite(streamDuration)
        ? Math.max(0, streamDuration)
        : Math.max(0, mediaDuration - startTime);

      return {
        id: `audio-${audioIndex}`,
        audioIndex,
        sourceIndex: stream.index,
        startTime,
        duration,
        label: formatAudioLabel(stream, audioIndex),
        channels: stream.channels || 2,
        codecName: stream.codec_name || "audio",
        language: stream.tags?.language || null,
        title: stream.tags?.title || null,
      };
    });

  return {
    filePath,
    fileName: path.basename(filePath),
    fileSizeBytes: fileStat.size,
    duration: mediaDuration,
    fps: parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate),
    width: videoStream.width || 1920,
    height: videoStream.height || 1080,
    audioTracks,
  };
}

async function createThumbnail(filePath, timeSeconds, session, width = 224, height = 126) {
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
    { encoding: "buffer", session },
  );

  return `data:image/png;base64,${imageBuffer.toString("base64")}`;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

async function generateThumbnails(filePath, duration, session) {
  const thumbCount = clamp(Math.round(duration / 8), 8, 18);
  const interval = duration > 0 ? duration / thumbCount : 0;
  const timecodes = Array.from({ length: thumbCount }, (_, index) =>
    duration > 0 ? Math.min(duration, interval * index + interval * 0.45) : 0,
  );

  return runWithConcurrency(timecodes, 4, (timeSeconds) => createThumbnail(filePath, timeSeconds, session));
}

async function extractAudioTrack(filePath, sourceIndex, outputPath, session) {
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
  ], { session });

  return outputPath;
}

async function generateWaveform(filePath, sourceIndex, duration, session) {
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
    { encoding: "buffer", session },
  );

  const floatArray = new Float32Array(
    rawBuffer.buffer,
    rawBuffer.byteOffset,
    Math.floor(rawBuffer.byteLength / 4),
  );

  const bucketCount = clamp(Math.round(duration * 140), 1400, 4800);
  const baseSamples = normalizeWaveform(Array.from(floatArray), bucketCount);

  return {
    duration: sampleRate > 0 ? floatArray.length / sampleRate : duration,
    samples: baseSamples,
    waveformLevels: buildWaveformLevels(baseSamples),
  };
}

function sendMediaAssetUpdate(webContents, payload) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.send("video:media-assets-updated", payload);
}

async function startMediaAssetPreparation(webContents, session, media) {
  try {
    const thumbnails = await generateThumbnails(session.sourcePath, media.duration, session);

    if (!session.cancelled && !session.released) {
      sendMediaAssetUpdate(webContents, {
        sessionId: session.sessionId,
        thumbnails,
      });
    }
  } catch (error) {
    if (!session.cancelled && !session.released) {
      console.warn("Unable to generate thumbnails.", error);
    }
  }

  await Promise.all(
    media.audioTracks.map(async (track) => {
      if (session.cancelled || session.released) {
        return;
      }

      const audioAssetId = `${track.id}.wav`;
      const audioOutputPath = path.join(session.tempDir, audioAssetId);

      try {
        const [waveform, extractedPath] = await Promise.all([
          generateWaveform(session.sourcePath, track.sourceIndex, media.duration, session),
          extractAudioTrack(session.sourcePath, track.sourceIndex, audioOutputPath, session),
        ]);

        if (session.cancelled || session.released) {
          return;
        }

        session.assets.set(audioAssetId, extractedPath);
        sendMediaAssetUpdate(webContents, {
          audioTrack: {
            ...track,
            audioUrl: createMediaUrl(session.sessionId, audioAssetId),
            volume: 1,
            ...waveform,
          },
          sessionId: session.sessionId,
        });
      } catch (error) {
        if (!session.cancelled && !session.released) {
          console.warn(`Unable to prepare audio track ${track.id}.`, error);
        }
      }
    }),
  );
}

async function analyzeMedia(webContents, filePath) {
  const resolvedPath = await validateOpenableMediaPath(filePath);
  const media = await probeMedia(resolvedPath);
  const tempDir = await fsp.mkdtemp(path.join(app.getPath("temp"), "clip-trimmer-"));
  const initialAudioTracks = media.audioTracks.map((track) => ({
    ...track,
    audioUrl: "",
    volume: 1,
    samples: [],
    waveformLevels: [],
  }));
  const sessionId = createMediaSession(resolvedPath, tempDir, initialAudioTracks);
  const session = mediaSessions.get(sessionId);
  const mediaProject = {
    ...media,
    audioTracks: initialAudioTracks,
    fileUrl: createMediaUrl(sessionId, "source"),
    sessionId,
    thumbnails: [],
  };

  void startMediaAssetPreparation(webContents, session, mediaProject);
  return mediaProject;
}

function validateExportPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid export request.");
  }

  const session = mediaSessions.get(payload.sessionId);

  if (!session || session.released) {
    throw new Error("The clip session is no longer available.");
  }

  const startTime = Number(payload.startTime);
  const endTime = Number(payload.endTime);

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) {
    throw new Error("Invalid trim range.");
  }

  const knownTracks = new Map(session.audioTracks.map((track) => [track.id, track]));
  const trackVolumes = (Array.isArray(payload.trackVolumes) ? payload.trackVolumes : []).map((entry) => {
    const track = knownTracks.get(entry?.trackId);

    if (!track || !Number.isFinite(entry?.volume)) {
      throw new Error("Invalid audio track settings.");
    }

    return {
      audioIndex: track.audioIndex,
      trackId: track.id,
      volume: clamp(Number(entry.volume), 0, 2),
    };
  });

  return {
    endTime,
    preciseExport: payload.preciseExport === true,
    session,
    startTime,
    trackVolumes,
  };
}

function canRetryWithFallback(error) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("could not write header") ||
    message.includes("codec not currently supported") ||
    message.includes("malformed aac bitstream") ||
    message.includes("muxer does not support") ||
    message.includes("non monotonically increasing") ||
    message.includes("invalid argument")
  );
}

async function exportClip(webContents, payload) {
  const { endTime, preciseExport, session, startTime, trackVolumes } = validateExportPayload(payload);
  const sourceParsed = path.parse(session.sourcePath);
  const fileName = typeof payload.fileName === "string" ? payload.fileName : "";
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
  const runExport = (fallbackEncode) =>
    runFfmpegExport(
      webContents,
      buildExportArgs({
        duration,
        fallbackEncode,
        outputPath: filePath,
        preciseExport,
        sourcePath: session.sourcePath,
        startTime,
        trackVolumes,
      }),
      duration,
    );

  try {
    await runExport(false);
  } catch (error) {
    if (!canRetryWithFallback(error)) {
      throw error;
    }

    try {
      await fsp.unlink(filePath);
    } catch {
      // Best effort cleanup before retrying with the compatibility encoder.
    }

    emitExportProgress(webContents, {
      etaSeconds: null,
      processedSeconds: 0,
      progress: 0,
      speed: null,
      totalSeconds: duration,
    });
    await runExport(true);
  }

  return { canceled: false, outputPath: filePath };
}

function runFfmpegExport(webContents, args, duration) {
  return new Promise((resolve, reject) => {
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
}

ipcMain.handle("video:open", async (event) => {
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

  return analyzeMedia(event.sender, filePaths[0]);
});

ipcMain.handle("video:analyze", async (event, filePath) => analyzeMedia(event.sender, filePath));
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

if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

app.setName(APP_NAME);

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
    logDevAppIdentity();
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
