// @ts-check

const MIN_AUDIBLE_VOLUME = 0.0001;
const OPENABLE_MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
const DEFAULT_VIDEO_ARGS = ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"];
const PRECISE_VIDEO_ARGS = ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p"];
const FALLBACK_VIDEO_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isOpenableMediaExtension(extension) {
  return OPENABLE_MEDIA_EXTENSIONS.has(String(extension || "").toLowerCase());
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

function parseFrameRate(rate) {
  if (!rate || rate === "0/0") {
    return 30;
  }

  const [numerator, denominator] = String(rate).split("/").map(Number);

  if (!numerator || !denominator) {
    return 30;
  }

  return numerator / denominator;
}

function formatAudioLabel(stream, audioIndex) {
  const pieces = [`Track ${audioIndex + 1}`];

  if (stream?.tags?.title) {
    pieces.push(stream.tags.title);
  } else if (stream?.tags?.language) {
    pieces.push(stream.tags.language.toUpperCase());
  }

  if (stream?.channels) {
    pieces.push(`${stream.channels}ch`);
  }

  return pieces.join(" / ");
}

function normalizeWaveform(samples, bucketCount) {
  if (!samples.length || !bucketCount) {
    return [];
  }

  const resolvedBucketCount = Math.max(1, Math.min(Math.floor(bucketCount), samples.length));
  const buckets = [];
  const step = samples.length / resolvedBucketCount;

  for (let index = 0; index < resolvedBucketCount; index += 1) {
    const start = Math.floor(index * step);
    const end = Math.max(start + 1, Math.floor((index + 1) * step));
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end && sampleIndex < samples.length; sampleIndex += 1) {
      const sample = Number(samples[sampleIndex] || 0);
      peak = Math.max(peak, Math.abs(sample));
    }

    buckets.push(Number(Math.min(1, peak).toFixed(4)));
  }

  return buckets;
}

function downsampleWaveform(samples, bucketCount) {
  if (!samples.length || !bucketCount) {
    return [];
  }

  if (bucketCount >= samples.length) {
    return samples.slice();
  }

  return normalizeWaveform(samples, bucketCount);
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

function getAudibleTrackVolumes(trackVolumes) {
  return (Array.isArray(trackVolumes) ? trackVolumes : [])
    .filter(
      (entry) =>
        entry &&
        typeof entry.trackId === "string" &&
        Number.isFinite(entry.audioIndex) &&
        Number.isFinite(entry.volume) &&
        entry.volume > MIN_AUDIBLE_VOLUME,
    )
    .map((entry) => ({
      audioIndex: entry.audioIndex,
      trackId: entry.trackId,
      volume: clamp(entry.volume, 0, 2),
    }));
}

function formatFfmpegTime(value) {
  return Number(value).toFixed(6);
}

function buildExportArgs({
  sourcePath,
  outputPath,
  startTime,
  duration,
  trackVolumes,
  fallbackEncode = false,
  preciseExport = false,
}) {
  const audibleEntries = getAudibleTrackVolumes(trackVolumes);
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
  ];

  if (!preciseExport) {
    args.push("-ss", startTime.toFixed(3), "-t", duration.toFixed(3));
  }

  if (hasAudio) {
    const audioFilterChains = audibleEntries.map((entry, index) => {
      const trimFilter = preciseExport
        ? `atrim=start=${formatFfmpegTime(startTime)}:duration=${formatFfmpegTime(duration)},asetpts=PTS-STARTPTS,`
        : "";

      return `[0:a:${entry.audioIndex}]${trimFilter}aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${entry.volume.toFixed(3)}[a${index}]`;
    });
    const audioOutputLabel = audibleEntries.length === 1 ? "[a0]" : "[amixout]";

    if (audibleEntries.length > 1) {
      audioFilterChains.push(
        `${audibleEntries.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audibleEntries.length}:normalize=0:dropout_transition=0[amixout]`,
      );
    }

    if (preciseExport) {
      args.push(
        "-filter_complex",
        [
          `[0:v:0]trim=start=${formatFfmpegTime(startTime)}:duration=${formatFfmpegTime(duration)},setpts=PTS-STARTPTS[v0]`,
          ...audioFilterChains,
        ].join(";"),
        "-map",
        "[v0]",
        "-map",
        audioOutputLabel,
      );
    } else {
      args.push("-filter_complex", audioFilterChains.join(";"), "-map", "0:v:0?", "-map", audioOutputLabel);
    }
  } else {
    if (preciseExport) {
      args.push(
        "-filter_complex",
        `[0:v:0]trim=start=${formatFfmpegTime(startTime)}:duration=${formatFfmpegTime(duration)},setpts=PTS-STARTPTS[v0]`,
        "-map",
        "[v0]",
      );
    } else {
      args.push("-map", "0:v:0?");
    }
  }

  const videoArgs = fallbackEncode ? FALLBACK_VIDEO_ARGS : preciseExport ? PRECISE_VIDEO_ARGS : DEFAULT_VIDEO_ARGS;
  args.push(...videoArgs, "-movflags", "+faststart");

  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  } else {
    args.push("-an");
  }

  args.push(outputPath);
  return args;
}

module.exports = {
  buildExportArgs,
  buildWaveformLevels,
  clamp,
  formatAudioLabel,
  getAudibleTrackVolumes,
  isOpenableMediaExtension,
  normalizeWaveform,
  parseFrameRate,
  parseProgressSpeed,
  parseTimestampToSeconds,
};
