import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  FocusEvent as ReactFocusEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { AudioTrack, ExportProgress, MediaProject } from "./types";
import copyIcon from "./assets/icons/copy.svg";
import cropIcon from "./assets/icons/crop.svg";
import minusIcon from "./assets/icons/minus.svg";
import searchIcon from "./assets/icons/search.svg";
import squareIcon from "./assets/icons/square.svg";
import closeIcon from "./assets/icons/x.svg";

type DragMode = "playhead" | "start" | "end" | null;
type VolumeDragState = {
  label: string;
  trackId: string;
  top: number;
  height: number;
};
type DroppedFile = File & {
  path?: string;
};

const MIN_TRIM_GAP = 0.04;
const COLLAPSED_TIMELINE_HEIGHT = 30;
const MIN_TRACK_VOLUME_DB = -30;
const MAX_TRACK_VOLUME_DB = 30;
const MIN_RULER_LABEL_SPACING = 84;
const RULER_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 90, 120, 300, 600, 900, 1800, 3600];
const FALLBACK_TIMELINE_HEADER_HEIGHT = 30;
const FALLBACK_TIMELINE_LANE_HEIGHT = 52;
const TOOLTIP_OFFSET = 14;
const TOOLTIP_MARGIN = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readCssPixelVar(name: string, fallback: number) {
  if (typeof window === "undefined") {
    return fallback;
  }

  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function gainToDb(gain: number) {
  const safeGain = Math.max(gain, 10 ** (MIN_TRACK_VOLUME_DB / 20));
  return clamp(20 * Math.log10(safeGain), MIN_TRACK_VOLUME_DB, MAX_TRACK_VOLUME_DB);
}

function dbToGain(db: number) {
  return 10 ** (clamp(db, MIN_TRACK_VOLUME_DB, MAX_TRACK_VOLUME_DB) / 20);
}

function isMutedVolumeDb(db: number) {
  return clamp(db, MIN_TRACK_VOLUME_DB, MAX_TRACK_VOLUME_DB) <= MIN_TRACK_VOLUME_DB + 0.05;
}

function volumeDbToGain(db: number) {
  return isMutedVolumeDb(db) ? 0 : dbToGain(db);
}

function volumeDbToPercent(db: number) {
  return ((MAX_TRACK_VOLUME_DB - clamp(db, MIN_TRACK_VOLUME_DB, MAX_TRACK_VOLUME_DB)) / (MAX_TRACK_VOLUME_DB - MIN_TRACK_VOLUME_DB)) * 100;
}

function clientYToVolumeDb(clientY: number, top: number, height: number) {
  const ratio = clamp((clientY - top) / Math.max(height, 1), 0, 1);
  return MAX_TRACK_VOLUME_DB - ratio * (MAX_TRACK_VOLUME_DB - MIN_TRACK_VOLUME_DB);
}

function formatTimecode(seconds: number) {
  const totalMilliseconds = Math.max(0, Math.floor(seconds * 1000));
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const centiseconds = Math.floor((totalMilliseconds % 1000) / 10);
  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${centiseconds
    .toString()
    .padStart(2, "0")}`;
}

function formatEta(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "Preparing";
  }

  const rounded = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
  }

  return `${secs}s`;
}

function formatRulerLabel(seconds: number) {
  const roundedSeconds = Math.max(0, Math.round(seconds));

  if (roundedSeconds < 60) {
    return `${roundedSeconds}s`;
  }

  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const secs = roundedSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

function pickRulerStep(duration: number, width: number) {
  const targetTickCount = Math.max(2, Math.floor(width / MIN_RULER_LABEL_SPACING));
  const minimumStep = duration / targetTickCount;
  return RULER_STEPS.find((step) => step >= minimumStep) ?? RULER_STEPS[RULER_STEPS.length - 1];
}

function formatDbLabel(db: number) {
  const normalized = Math.abs(db) < 0.05 ? 0 : db;
  const rounded = Math.round(normalized * 10) / 10;
  const value = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${value} dB`;
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function formatFrameTime(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "--";
  }

  return `${milliseconds.toFixed(2)} ms`;
}

function formatFps(fps: number) {
  if (!Number.isFinite(fps) || fps <= 0) {
    return "--";
  }

  const rounded = Math.round(fps * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)} fps`;
}

function formatResolution(width: number, height: number) {
  if (width <= 0 || height <= 0) {
    return "--";
  }

  return `${formatCompactNumber(width)} x ${formatCompactNumber(height)}`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function describeError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unexpected error.";
}

function formatActionError(action: string, error: unknown) {
  return `Unable to ${action}. ${describeError(error)}`;
}

function hasDraggedFiles(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return false;
  }

  return Array.from(dataTransfer.types).includes("Files");
}

function getDroppedFilePath(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return null;
  }

  const droppedFile = dataTransfer.files.item(0) as DroppedFile | null;
  return droppedFile?.path ?? null;
}

function readFourCc(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function decodePcmWave(arrayBuffer: ArrayBuffer, context: AudioContext) {
  const view = new DataView(arrayBuffer);

  if (view.byteLength < 44 || readFourCc(view, 0) !== "RIFF" || readFourCc(view, 8) !== "WAVE") {
    throw new Error("Unsupported WAV container.");
  }

  let offset = 12;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let formatCode = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readFourCc(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16) {
      formatCode = view.getUint16(chunkDataOffset, true);
      channelCount = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!dataOffset || !dataSize) {
    throw new Error("WAV data chunk missing.");
  }

  if (formatCode !== 1 || bitsPerSample !== 16 || channelCount < 1 || !sampleRate) {
    throw new Error("Unsupported WAV encoding.");
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (channelCount * bytesPerSample));
  const audioBuffer = context.createBuffer(channelCount, frameCount, sampleRate);
  const channelData = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index));
  let sampleOffset = dataOffset;

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      channelData[channel][frame] = view.getInt16(sampleOffset, true) / 32768;
      sampleOffset += bytesPerSample;
    }
  }

  return audioBuffer;
}

function pickWaveformSamples(track: AudioTrack, targetWidth: number) {
  const levels = track.waveformLevels?.length
    ? [...track.waveformLevels].sort((left, right) => left.bucketCount - right.bucketCount)
    : [{ bucketCount: track.samples.length, samples: track.samples }];

  const minimumBucketCount = Math.max(64, Math.ceil(targetWidth));
  return (
    levels.find((level) => level.bucketCount >= minimumBucketCount)?.samples ||
    levels[levels.length - 1]?.samples ||
    []
  );
}

function AudioLaneWaveform({
  track,
  volumeGain,
  muted,
}: {
  track: AudioTrack;
  volumeGain: number;
  muted: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformColor = muted ? "rgba(159, 167, 179, 0.68)" : "rgba(81, 226, 132, 0.9)";

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const render = () => {
      const context = canvas.getContext("2d");

      if (!context) {
        return;
      }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const renderWidth = Math.max(1, Math.floor(width * dpr));
      const samples = pickWaveformSamples(track, renderWidth);

      if (!samples.length || width <= 0 || height <= 0) {
        return;
      }

      const mid = height / 2;
      const maxAmplitude = height * 0.46;
      const sampleStep = samples.length / renderWidth;
      const centerLineY = Math.floor(mid);
      context.fillStyle = waveformColor;
      context.fillRect(0, centerLineY, width, 1);

      for (let x = 0; x < renderWidth; x += 1) {
        const start = Math.floor(x * sampleStep);
        const end = Math.max(start + 1, Math.floor((x + 1) * sampleStep));
        let peak = 0;

        for (let index = start; index < end; index += 1) {
          peak = Math.max(peak, Math.abs(samples[index] ?? 0));
        }

        const amplitudeScale = muted ? 0.72 : volumeGain;
        const amplitude = Math.min(maxAmplitude, peak * amplitudeScale * maxAmplitude);

        if (amplitude < 0.6) {
          continue;
        }

        context.fillRect(x / dpr, mid - amplitude, 1 / dpr, amplitude * 2);
      }
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [muted, track.samples, track.waveformLevels, volumeGain, waveformColor]);

  return (
    <div className="timeline-waveform">
      <canvas aria-hidden="true" className="timeline-waveform-canvas" ref={canvasRef} />
    </div>
  );
}

type AudioPlaybackState = {
  active: boolean;
};

type FloatingTooltipState = {
  label: string;
  motion?: "bob";
  placement: "above" | "below";
  x: number;
  y: number;
};

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const timelineHeaderRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const titleBadgeRef = useRef<HTMLButtonElement | null>(null);
  const tooltipFadeTimeoutRef = useRef<number | null>(null);
  const tooltipTimeoutRef = useRef<number | null>(null);
  const tooltipActiveRef = useRef(false);
  const shouldAutoplayRef = useRef(false);
  const syncFrameRef = useRef<number | null>(null);
  const trimRef = useRef({ start: 0, end: 0 });
  const loadingRef = useRef(false);
  const queuedOpenFileRef = useRef<string | null>(null);
  const expandedTimelineHeightRef = useRef<number | null>(null);
  const dividerDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBuffersRef = useRef<Record<string, AudioBuffer>>({});
  const sourceNodesRef = useRef<Record<string, AudioBufferSourceNode>>({});
  const gainNodesRef = useRef<Record<string, GainNode>>({});
  const audioLoadTokenRef = useRef(0);
  const audioLoadPromiseRef = useRef<Promise<number> | null>(null);
  const playbackToggleRef = useRef(false);
  const viewportDragDepthRef = useRef(0);
  const audioPlaybackRef = useRef<AudioPlaybackState>({
    active: false,
  });
  const [media, setMedia] = useState<MediaProject | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [timelineHeight, setTimelineHeight] = useState(COLLAPSED_TIMELINE_HEIGHT);
  const [resizingTimeline, setResizingTimeline] = useState(false);
  const [trackVolumeDb, setTrackVolumeDb] = useState<Record<string, number>>({});
  const [volumeDrag, setVolumeDrag] = useState<VolumeDragState | null>(null);
  const [timelineWidth, setTimelineWidth] = useState(0);
  const [isViewportDragActive, setIsViewportDragActive] = useState(false);
  const [tooltip, setTooltip] = useState<FloatingTooltipState | null>(null);
  const [renderedTooltip, setRenderedTooltip] = useState<FloatingTooltipState | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{
    arrowLeft: number;
    left: number;
    placement: FloatingTooltipState["placement"];
    top: number;
  } | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const getTimelineMaxHeight = () => {
    const viewportMaxHeight = Math.max(
      COLLAPSED_TIMELINE_HEIGHT,
      Math.min(window.innerHeight * 0.58, window.innerHeight - 120),
    );

    if (!media) {
      return viewportMaxHeight;
    }

    const laneCount = 1 + media.audioTracks.length;
    const headerHeight =
      timelineHeaderRef.current?.getBoundingClientRect().height ??
      readCssPixelVar("--timeline-header-height", FALLBACK_TIMELINE_HEADER_HEIGHT);
    const laneHeight = readCssPixelVar("--lane-height", FALLBACK_TIMELINE_LANE_HEIGHT);
    const contentHeight = headerHeight + laneCount * laneHeight;

    return Math.max(COLLAPSED_TIMELINE_HEIGHT, Math.min(contentHeight, viewportMaxHeight));
  };
  const clearTooltipTimeout = () => {
    if (tooltipTimeoutRef.current !== null) {
      window.clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
  };
  const clearTooltipFadeTimeout = () => {
    if (tooltipFadeTimeoutRef.current !== null) {
      window.clearTimeout(tooltipFadeTimeoutRef.current);
      tooltipFadeTimeoutRef.current = null;
    }
  };
  const showTooltip = (
    label: string,
    clientX: number,
    clientY: number,
    placement: FloatingTooltipState["placement"] = "above",
    motion?: FloatingTooltipState["motion"],
  ) => {
    clearTooltipTimeout();
    setTooltip({
      label,
      motion,
      placement,
      x: clientX,
      y: clientY,
    });
  };
  const hideTooltip = () => {
    clearTooltipTimeout();
    setTooltip(null);
  };
  const showTooltipFromElement = (
    label: string,
    element: HTMLElement,
    placement: FloatingTooltipState["placement"] = "above",
    motion?: FloatingTooltipState["motion"],
  ) => {
    const rect = element.getBoundingClientRect();
    showTooltip(
      label,
      rect.left + rect.width / 2,
      placement === "below" ? rect.bottom : rect.top,
      placement,
      motion,
    );
  };
  const bindTooltip = (
    label: string,
    {
      keepVisible,
      placement = "above",
    }: {
      keepVisible?: () => boolean;
      placement?: FloatingTooltipState["placement"];
    } = {},
  ) => ({
    onBlur: () => {
      if (!keepVisible?.()) {
        hideTooltip();
      }
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      showTooltipFromElement(label, event.currentTarget, placement);
    },
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      showTooltip(label, event.clientX, event.clientY, placement);
    },
    onPointerLeave: () => {
      if (!keepVisible?.()) {
        hideTooltip();
      }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      showTooltip(label, event.clientX, event.clientY, placement);
    },
  });
  const showOpenFileHint = () => {
    const badge = titleBadgeRef.current;

    if (!badge) {
      return;
    }

    showTooltipFromElement("Click Open File", badge, "below", "bob");
    tooltipTimeoutRef.current = window.setTimeout(() => {
      tooltipTimeoutRef.current = null;
      setTooltip(null);
    }, 1800);
  };
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  useEffect(() => {
    clearTooltipFadeTimeout();

    if (tooltip) {
      setRenderedTooltip(tooltip);
      if (!tooltipActiveRef.current) {
        setTooltipVisible(false);
        tooltipFadeTimeoutRef.current = window.setTimeout(() => {
          tooltipFadeTimeoutRef.current = null;
          setTooltipVisible(true);
        }, 16);
      } else {
        setTooltipVisible(true);
      }
      tooltipActiveRef.current = true;
      return;
    }

    tooltipActiveRef.current = false;
    setTooltipVisible(false);
    tooltipFadeTimeoutRef.current = window.setTimeout(() => {
      tooltipFadeTimeoutRef.current = null;
      setRenderedTooltip(null);
      setTooltipPosition(null);
    }, 150);
  }, [tooltip]);

  useEffect(
    () =>
      window.videoApp.onExportProgress((nextProgress) => {
        setExportProgress(nextProgress);
      }),
    [],
  );

  useLayoutEffect(() => {
    if (!renderedTooltip) {
      return;
    }

    const updateTooltipPosition = () => {
      const element = tooltipRef.current;

      if (!element) {
        return;
      }

      const rect = element.getBoundingClientRect();
      const maxLeft = Math.max(TOOLTIP_MARGIN, window.innerWidth - rect.width - TOOLTIP_MARGIN);
      const maxTop = Math.max(TOOLTIP_MARGIN, window.innerHeight - rect.height - TOOLTIP_MARGIN);
      const belowTop = renderedTooltip.y + TOOLTIP_OFFSET;
      const aboveTop = renderedTooltip.y - rect.height - TOOLTIP_OFFSET;
      const canPlaceBelow = belowTop + rect.height <= window.innerHeight - TOOLTIP_MARGIN;
      const canPlaceAbove = aboveTop >= TOOLTIP_MARGIN;

      let resolvedPlacement = renderedTooltip.placement;
      let top = renderedTooltip.placement === "below" ? belowTop : aboveTop;

      if (renderedTooltip.placement === "below" && !canPlaceBelow && canPlaceAbove) {
        resolvedPlacement = "above";
        top = aboveTop;
      } else if (renderedTooltip.placement === "above" && !canPlaceAbove && canPlaceBelow) {
        resolvedPlacement = "below";
        top = belowTop;
      }

      const left = clamp(renderedTooltip.x - rect.width / 2, TOOLTIP_MARGIN, maxLeft);
      const nextPosition = {
        arrowLeft: clamp(renderedTooltip.x - left, 12, rect.width - 12),
        left,
        placement: resolvedPlacement,
        top: clamp(top, TOOLTIP_MARGIN, maxTop),
      };

      setTooltipPosition((current) =>
        current &&
        current.arrowLeft === nextPosition.arrowLeft &&
        current.left === nextPosition.left &&
        current.placement === nextPosition.placement &&
        current.top === nextPosition.top
          ? current
          : nextPosition,
      );
    };

    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);

    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
    };
  }, [renderedTooltip]);

  useEffect(() => {
    trimRef.current = { start: trimStart, end: trimEnd };
  }, [trimEnd, trimStart]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  const applyMediaProject = (nextMedia: MediaProject) => {
    if (videoRef.current) {
      videoRef.current.pause();
    }

    stopAudioPlayback();
    viewportDragDepthRef.current = 0;
    setIsViewportDragActive(false);
    shouldAutoplayRef.current = true;
    setErrorMessage(null);
    setMedia(nextMedia);
    setCurrentTime(0);
    setTrimStart(0);
    setTrimEnd(nextMedia.duration);
  };

  useEffect(() => {
    if (!media) {
      setTrackVolumeDb({});
      return;
    }

    setTrackVolumeDb(
      Object.fromEntries(media.audioTracks.map((track) => [track.id, gainToDb(track.volume)])),
    );
  }, [media]);

  useEffect(() => {
    let cancelled = false;
    const syncWindowState = async () => {
      const state = await window.videoApp.getWindowState();

      if (!cancelled) {
        setIsWindowMaximized(state.isMaximized);
      }
    };

    void syncWindowState();

    const unsubscribe = window.videoApp.onWindowStateChange((state) => {
      setIsWindowMaximized(state.isMaximized);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.videoApp.onOpenFileRequested((filePath) => {
      void loadMediaFromPath(filePath);
    });

    return unsubscribe;
  }, []);

  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;

    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "BUTTON") {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.code === "KeyO") {
      event.preventDefault();
      void loadMedia();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.code === "KeyE" && media) {
      event.preventDefault();
      void handleExport();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.code === "KeyT" && media) {
      event.preventDefault();
      toggleTimelineCollapsed();
      return;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && media && event.code === "Comma") {
      event.preventDefault();
      stepPlaybackByFrames(-1);
      return;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && media && event.code === "Period") {
      event.preventDefault();
      stepPlaybackByFrames(1);
      return;
    }

    if (event.code === "Space" && media) {
      event.preventDefault();
      void togglePlayback();
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      handleGlobalKeyDown(event);
    };

    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    const element = videoRef.current;

    if (!element || !media) {
      return;
    }

    element.load();
  }, [media]);

  useEffect(() => {
    let cancelled = false;
    const token = audioLoadTokenRef.current + 1;
    audioLoadTokenRef.current = token;
    audioBuffersRef.current = {};
    audioLoadPromiseRef.current = null;
    if (!media) {
      return;
    }

    const loadBuffers = async () => {
      const context = getAudioContext();
      const decodedEntries: Array<readonly [string, AudioBuffer]> = [];

      for (const track of media.audioTracks) {
        try {
          const response = await fetch(track.audioUrl);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = decodePcmWave(arrayBuffer, context);
          decodedEntries.push([track.id, audioBuffer] as const);
        } catch (error) {
          console.error(`Unable to decode audio track ${track.id}.`, error);
        }
      }

      if (cancelled || audioLoadTokenRef.current !== token) {
        return 0;
      }

      audioBuffersRef.current = Object.fromEntries(decodedEntries);
      if (decodedEntries.length !== media.audioTracks.length) {
        console.warn(`Loaded ${decodedEntries.length} of ${media.audioTracks.length} audio tracks.`);
      }

      return decodedEntries.length;
    };

    audioLoadPromiseRef.current = loadBuffers();

    return () => {
      cancelled = true;
    };
  }, [media]);

  useEffect(() => {
    return () => {
      clearTooltipTimeout();
      clearTooltipFadeTimeout();

      if (syncFrameRef.current !== null) {
        cancelAnimationFrame(syncFrameRef.current);
      }

      stopAudioPlayback();
      void audioContextRef.current?.close();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (media?.sessionId) {
        void window.videoApp.releaseMediaSession(media.sessionId);
      }
    };
  }, [media]);

  useEffect(() => {
    Object.entries(gainNodesRef.current).forEach(([trackId, gain]) => {
      gain.gain.value = volumeDbToGain(trackVolumeDb[trackId] ?? 0);
    });
  }, [trackVolumeDb]);

  useEffect(() => {
    const tick = () => {
      const video = videoRef.current;

      if (video && !video.paused) {
        if (video.currentTime >= trimRef.current.end) {
          video.pause();
          video.currentTime = trimRef.current.end;
          stopAudioPlayback();
          setCurrentTime(trimRef.current.end);
        } else {
          setCurrentTime(video.currentTime);
        }
      }

      syncFrameRef.current = window.requestAnimationFrame(tick);
    };

    syncFrameRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (syncFrameRef.current !== null) {
        cancelAnimationFrame(syncFrameRef.current);
        syncFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!media || !dragMode) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      const element = videoRef.current;
      const nextTime = timeFromPointer(event.clientX);
      const { start, end } = trimRef.current;

      if (dragMode === "playhead") {
        const nextPlayheadTime = clamp(nextTime, start, end);
        setCurrentTime(nextPlayheadTime);

        if (element) {
          element.currentTime = nextPlayheadTime;
        }

        if (audioPlaybackRef.current.active) {
          void restartAudioPlayback(nextPlayheadTime);
        }

        return;
      }

      if (dragMode === "start") {
        const nextTrimStart = Math.min(nextTime, end - MIN_TRIM_GAP);
        setTrimStart(nextTrimStart);
        showTooltip(`Start ${formatTimecode(nextTrimStart)}`, event.clientX, event.clientY);

        if (element && element.currentTime < nextTrimStart) {
          element.currentTime = nextTrimStart;
          setCurrentTime(nextTrimStart);

          if (audioPlaybackRef.current.active) {
            void restartAudioPlayback(nextTrimStart);
          }
        }

        return;
      }

      const nextTrimEnd = Math.max(nextTime, start + MIN_TRIM_GAP);
      setTrimEnd(nextTrimEnd);
      showTooltip(`End ${formatTimecode(nextTrimEnd)}`, event.clientX, event.clientY);

      if (element && element.currentTime > nextTrimEnd) {
        element.currentTime = nextTrimEnd;
        setCurrentTime(nextTrimEnd);

        if (audioPlaybackRef.current.active) {
          void restartAudioPlayback(nextTrimEnd);
        }
      }
    };

    const handleUp = () => {
      setDragMode(null);
      hideTooltip();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragMode, media]);

  useEffect(() => {
    if (!volumeDrag) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      const nextDb = clientYToVolumeDb(event.clientY, volumeDrag.top, volumeDrag.height);
      setTrackVolumeDb((current) => ({
        ...current,
        [volumeDrag.trackId]: nextDb,
      }));
      showTooltip(`${volumeDrag.label} ${formatDbLabel(nextDb)}`, event.clientX, event.clientY);
    };

    const handleUp = () => {
      setVolumeDrag(null);
      hideTooltip();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [volumeDrag]);

  useEffect(() => {
    if (!resizingTimeline) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      const current = dividerDragRef.current;

      if (!current) {
        return;
      }

      const maxHeight = getTimelineMaxHeight();
      const nextHeight = clamp(current.startHeight - (event.clientY - current.startY), COLLAPSED_TIMELINE_HEIGHT, maxHeight);
      setTimelineHeight(nextHeight);
      showTooltip("Resize timeline (Ctrl + T)", event.clientX, event.clientY, "below");
    };

    const handleUp = () => {
      dividerDragRef.current = null;
      setResizingTimeline(false);
      hideTooltip();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [resizingTimeline]);

  useEffect(() => {
    const syncTimelineHeight = () => {
      setTimelineHeight((current) => {
        const nextHeight = clamp(current, COLLAPSED_TIMELINE_HEIGHT, getTimelineMaxHeight());
        return Math.abs(nextHeight - current) < 0.5 ? current : nextHeight;
      });
    };

    syncTimelineHeight();
    window.addEventListener("resize", syncTimelineHeight);

    return () => {
      window.removeEventListener("resize", syncTimelineHeight);
    };
  }, [media]);

  useEffect(() => {
    if (timelineHeight > COLLAPSED_TIMELINE_HEIGHT + 8) {
      expandedTimelineHeightRef.current = timelineHeight;
    }
  }, [timelineHeight]);

  useEffect(() => {
    const element = timelineRef.current;

    if (!element) {
      return;
    }

    const updateWidth = () => {
      setTimelineWidth(element.getBoundingClientRect().width);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  async function loadMedia() {
    if (loadingRef.current) {
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    setErrorMessage(null);

    try {
      const nextMedia = await window.videoApp.openVideo();

      if (!nextMedia) {
        return;
      }

      applyMediaProject(nextMedia);
    } catch (error) {
      setErrorMessage(formatActionError("open the clip", error));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  async function loadMediaFromPath(filePath: string) {
    if (loadingRef.current) {
      queuedOpenFileRef.current = filePath;
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    setErrorMessage(null);

    try {
      const nextMedia = await window.videoApp.analyzeVideo(filePath);
      applyMediaProject(nextMedia);
    } catch (error) {
      setErrorMessage(formatActionError("open the clip", error));
    } finally {
      loadingRef.current = false;
      setLoading(false);

      if (queuedOpenFileRef.current && queuedOpenFileRef.current !== filePath) {
        const queuedFilePath = queuedOpenFileRef.current;
        queuedOpenFileRef.current = null;
        void loadMediaFromPath(queuedFilePath);
      } else {
        queuedOpenFileRef.current = null;
      }
    }
  }

  async function handleExport() {
    if (!media || exporting) {
      return;
    }

    setErrorMessage(null);
    setExporting(true);
    setExportProgress({
      progress: 0,
      processedSeconds: 0,
      totalSeconds: Math.max(0.04, trimEnd - trimStart),
      etaSeconds: null,
      speed: null,
    });

    try {
      await window.videoApp.exportClip({
        sourcePath: media.filePath,
        fileName: media.fileName,
        startTime: trimStart,
        endTime: trimEnd,
        trackVolumes: media.audioTracks.map((track) => ({
          audioIndex: track.audioIndex,
          volume: volumeDbToGain(trackVolumeDb[track.id] ?? gainToDb(track.volume)),
        })),
      });
    } catch (error) {
      setErrorMessage(formatActionError("export the clip", error));
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }

  async function playVideo(element: HTMLVideoElement) {
    try {
      await element.play();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      throw error;
    }
  }

  function pausePlayback() {
    const element = videoRef.current;

    stopAudioPlayback();

    if (element && !element.paused) {
      element.pause();
    }
  }

  function stepPlaybackByFrames(frameDelta: number) {
    const element = videoRef.current;

    if (!element || !media) {
      return;
    }

    const fps = media.fps > 0 ? media.fps : 30;
    const frameDuration = 1 / fps;
    const nextTime = clamp(element.currentTime + frameDelta * frameDuration, trimStart, trimEnd);

    pausePlayback();
    element.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function toggleTimelineCollapsed() {
    dividerDragRef.current = null;
    setResizingTimeline(false);
    hideTooltip();
    setTimelineHeight((current) => {
      if (current > COLLAPSED_TIMELINE_HEIGHT + 8) {
        expandedTimelineHeightRef.current = current;
        return COLLAPSED_TIMELINE_HEIGHT;
      }

      const maxHeight = getTimelineMaxHeight();
      const nextHeight = clamp(
        expandedTimelineHeightRef.current ?? maxHeight,
        COLLAPSED_TIMELINE_HEIGHT,
        maxHeight,
      );
      expandedTimelineHeightRef.current = nextHeight;
      return nextHeight;
    });
  }

  function getAudioContext() {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    return audioContextRef.current;
  }

  async function primeAudioContext() {
    if (!media?.audioTracks.length) {
      return;
    }

    const context = getAudioContext();

    if (context.state === "suspended") {
      await context.resume();
    }
  }

  async function waitForAudioBuffers() {
    if (!media?.audioTracks.length) {
      return true;
    }

    const loadPromise = audioLoadPromiseRef.current;

    if (!loadPromise) {
      return Object.keys(audioBuffersRef.current).length > 0;
    }

    const loadedCount = await loadPromise;
    return loadedCount > 0;
  }

  async function startPlayback() {
    const element = videoRef.current;

    if (!element || !media) {
      return;
    }

    let nextTime = element.currentTime;

    if (nextTime < trimStart || nextTime >= trimEnd) {
      nextTime = trimStart;
      element.currentTime = nextTime;
      setCurrentTime(nextTime);
    }

    await primeAudioContext();
    const hasAudio = await waitForAudioBuffers();

    try {
      await playVideo(element);
      if (hasAudio) {
        await startAudioPlayback(element.currentTime);
      }
    } catch (error) {
      stopAudioPlayback();
      throw error;
    }
  }

  function stopAudioPlayback() {
    Object.values(sourceNodesRef.current).forEach((source) => {
      try {
        source.stop();
      } catch {}
      source.disconnect();
    });

    Object.values(gainNodesRef.current).forEach((gain) => {
      gain.disconnect();
    });

    sourceNodesRef.current = {};
    gainNodesRef.current = {};
    audioPlaybackRef.current.active = false;
  }

  async function startAudioPlayback(startTime: number) {
    if (!media) {
      return false;
    }

    const context = getAudioContext();

    if (context.state === "suspended") {
      await context.resume();
    }

    stopAudioPlayback();
    let startedTrackCount = 0;

    media.audioTracks.forEach((track) => {
      const buffer = audioBuffersRef.current[track.id];

      if (!buffer) {
        return;
      }

      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = volumeDbToGain(trackVolumeDb[track.id] ?? gainToDb(track.volume));
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(context.destination);
      source.start(0, clamp(startTime, 0, Math.max(0, buffer.duration - 0.01)));
      sourceNodesRef.current[track.id] = source;
      gainNodesRef.current[track.id] = gain;
      startedTrackCount += 1;
    });

    if (!startedTrackCount) {
      return false;
    }

    audioPlaybackRef.current = {
      active: true,
    };
    return true;
  }

  async function restartAudioPlayback(startTime: number) {
    if (!audioPlaybackRef.current.active) {
      stopAudioPlayback();
      return;
    }

    await startAudioPlayback(startTime);
  }

  async function togglePlayback() {
    const element = videoRef.current;

    if (!element || !media || playbackToggleRef.current) {
      return;
    }

    playbackToggleRef.current = true;

    try {
      if (element.paused || element.ended) {
        await startPlayback();
        return;
      }

      pausePlayback();
    } catch (error) {
      setErrorMessage(formatActionError("start playback", error));
    } finally {
      playbackToggleRef.current = false;
    }
  }

  function timeFromPointer(clientX: number) {
    const rect = timelineRef.current?.getBoundingClientRect();

    if (!rect || !media) {
      return 0;
    }

    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * media.duration;
  }

  function seekFromPointer(clientX: number) {
    if (!media) {
      return;
    }

    const nextTime = clamp(timeFromPointer(clientX), trimStart, trimEnd);
    setCurrentTime(nextTime);
    setDragMode("playhead");

    if (videoRef.current) {
      videoRef.current.currentTime = nextTime;
    }

    if (audioPlaybackRef.current.active) {
      void restartAudioPlayback(nextTime);
    }
  }

  const safeDuration = Math.max(media?.duration ?? 0, 0.001);
  const trimLeft = media ? `${(trimStart / safeDuration) * 100}%` : "0%";
  const trimWidth = media ? `${((trimEnd - trimStart) / safeDuration) * 100}%` : "100%";
  const playheadLeft = media ? `${(currentTime / safeDuration) * 100}%` : "0%";
  const timelineExpanded = timelineHeight > COLLAPSED_TIMELINE_HEIGHT + 8;
  const openFileTooltip = exporting ? "Export in progress" : "Open a new file (Ctrl+O)";
  const minimizeTooltip = "Minimize window";
  const maximizeTooltip = isWindowMaximized ? "Restore window" : "Maximize window";
  const closeTooltip = "Close window";
  const resizeTimelineTooltip = "Resize timeline (Ctrl + T)";
  const trimStartTooltip = `Start ${formatTimecode(trimStart)}`;
  const trimEndTooltip = `End ${formatTimecode(trimEnd)}`;
  const exportProgressValue = clamp(exportProgress?.progress ?? 0, 0, 1);
  const exportProgressLabel =
    exportProgressValue > 0 ? `Exporting ${Math.round(exportProgressValue * 100)}%` : "Exporting";
  const exportEtaLabel =
    exportProgressValue >= 1 ? "Finalizing" : `ETA ${formatEta(exportProgress?.etaSeconds ?? null)}`;
  const exportBusyTooltip = exporting ? "Export in progress" : "Export trimmed clip (Ctrl+E)";
  const badgeLabel = media ? media.fileName : loading ? "Opening Clip" : "Open File";
  const badgeIsEmpty = !media && !loading;
  const badgeStateKey = loading ? "loading" : media?.fileName ?? "empty";
  const playerShellStyle = {
    ["--timeline-height" as string]: `${timelineHeight}px`,
  } as CSSProperties;
  const clipFps = media?.fps && media.fps > 0 ? media.fps : 0;
  const trimDuration = media ? Math.max(0, trimEnd - trimStart) : 0;
  const renderedFrames = media ? Math.round(trimDuration * clipFps) : 0;
  const frameTime = clipFps > 0 ? 1000 / clipFps : 0;
  const estimatedTrimSizeBytes =
    media && media.duration > 0 ? media.fileSizeBytes * clamp(trimDuration / media.duration, 0, 1) : 0;
  const clipStats = media
    ? [
        {
          label: "Frame time",
          value: formatFrameTime(frameTime),
        },
        {
          label: "Rendered frames",
          value: formatCompactNumber(renderedFrames),
        },
        {
          label: "Clip FPS",
          value: formatFps(clipFps),
        },
        {
          label: "Resolution",
          value: formatResolution(media.width, media.height),
        },
        {
          label: "Clip size",
          value: formatBytes(media.fileSizeBytes),
        },
        {
          label: "Est. trim size",
          value: formatBytes(estimatedTrimSizeBytes),
        },
      ]
    : [];
  const rulerTicks =
    media && timelineWidth > 0
      ? (() => {
          const step = pickRulerStep(media.duration, timelineWidth);
          const values = Array.from({ length: Math.floor(media.duration / step) + 1 }, (_, index) => index * step);
          const lastValue = values[values.length - 1] ?? 0;

          if (Math.abs(lastValue - media.duration) > 0.001) {
            values.push(media.duration);
          }

          return values.map((value) => ({
            label: formatRulerLabel(value),
            left: `${(value / safeDuration) * 100}%`,
          }));
        })()
      : [];

  return (
    <main className="app-shell">
      <header className="window-header">
        <div className="window-header-main">
          <div className="window-header-actions">
            <button
              className={`window-action-button window-action-button-primary${exporting ? " is-busy" : ""}`}
              disabled={!media || exporting}
              {...bindTooltip(exportBusyTooltip)}
              onClick={() => {
                void handleExport();
              }}
              type="button"
            >
              {exporting ? (
                <span aria-hidden="true" className="window-action-spinner" />
              ) : (
                <img alt="" aria-hidden="true" className="window-action-icon" src={cropIcon} />
              )}
              <span className="sr-only">{exportBusyTooltip}</span>
            </button>
          </div>

          <div className="window-title">
            <button
              className={`window-title-badge window-title-button${badgeIsEmpty ? " is-empty" : ""}${loading ? " is-loading" : ""}`}
              disabled={loading || exporting}
              {...bindTooltip(openFileTooltip)}
              onClick={() => {
                void loadMedia();
              }}
              ref={titleBadgeRef}
              type="button"
            >
              <span className="window-title-content" key={badgeStateKey}>
                {loading ? <span aria-hidden="true" className="window-title-spinner" /> : null}
                {!media && !loading ? (
                  <img
                    alt=""
                    aria-hidden="true"
                    className="window-title-icon"
                    src={searchIcon}
                  />
                ) : null}
                <span className="window-title-meta">{badgeLabel}</span>
              </span>
              <span className="sr-only">{openFileTooltip}</span>
            </button>
          </div>
        </div>

        <div className="window-controls">
          <button
            className="window-control-button"
            onClick={() => {
              void window.videoApp.minimizeWindow();
            }}
            type="button"
          >
            <img alt="" aria-hidden="true" className="window-control-icon" src={minusIcon} />
            <span className="sr-only">{minimizeTooltip}</span>
          </button>

          <button
            className="window-control-button"
            onClick={async () => {
              const state = await window.videoApp.toggleMaximizeWindow();
              setIsWindowMaximized(state.isMaximized);
            }}
            type="button"
          >
            <img
              alt=""
              aria-hidden="true"
              className="window-control-icon"
              src={isWindowMaximized ? copyIcon : squareIcon}
            />
            <span className="sr-only">{maximizeTooltip}</span>
          </button>

          <button
            className="window-control-button window-control-button-close"
            onClick={() => {
              void window.videoApp.closeWindow();
            }}
            type="button"
          >
            <img alt="" aria-hidden="true" className="window-control-icon" src={closeIcon} />
            <span className="sr-only">{closeTooltip}</span>
          </button>
        </div>
      </header>

      <section className={`player-shell${timelineExpanded ? " timeline-open" : ""}`} style={playerShellStyle}>
        <div
          aria-label="Video frame"
          className={`viewport${isViewportDragActive ? " is-drop-target" : ""}`}
          onDragEnter={(event: ReactDragEvent<HTMLDivElement>) => {
            if (!hasDraggedFiles(event.dataTransfer)) {
              return;
            }

            event.preventDefault();
            viewportDragDepthRef.current += 1;
            setIsViewportDragActive(true);
          }}
          onDragLeave={(event: ReactDragEvent<HTMLDivElement>) => {
            if (!hasDraggedFiles(event.dataTransfer)) {
              return;
            }

            event.preventDefault();
            viewportDragDepthRef.current = Math.max(0, viewportDragDepthRef.current - 1);

            if (viewportDragDepthRef.current === 0) {
              setIsViewportDragActive(false);
            }
          }}
          onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
            if (!hasDraggedFiles(event.dataTransfer)) {
              return;
            }

            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";

            if (!isViewportDragActive) {
              setIsViewportDragActive(true);
            }
          }}
          onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
            if (!hasDraggedFiles(event.dataTransfer)) {
              return;
            }

            event.preventDefault();
            viewportDragDepthRef.current = 0;
            setIsViewportDragActive(false);

            const filePath = getDroppedFilePath(event.dataTransfer);

            if (!filePath) {
              return;
            }

            void loadMediaFromPath(filePath);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }

            if (media) {
              event.preventDefault();
              void togglePlayback();
              return;
            }

            event.preventDefault();
            showOpenFileHint();
          }}
        >
          {media ? (
            <video
              className="viewport-video"
              key={media.filePath}
              onCanPlay={() => {
                if (!shouldAutoplayRef.current) {
                  return;
                }

                shouldAutoplayRef.current = false;
                void startPlayback();
              }}
              onLoadedMetadata={() => {
                const element = videoRef.current;

                if (!element) {
                  return;
                }

                element.currentTime = trimStart;
                setCurrentTime(trimStart);
              }}
              onPause={() => {
                stopAudioPlayback();
              }}
              onSeeking={() => {
                const element = videoRef.current;

                if (!element) {
                  return;
                }

                setCurrentTime(element.currentTime);

                if (audioPlaybackRef.current.active) {
                  void restartAudioPlayback(element.currentTime);
                }
              }}
              onTimeUpdate={() => {
                const element = videoRef.current;

                if (!element || audioPlaybackRef.current.active) {
                  return;
                }

                if (element.currentTime >= trimEnd) {
                  element.currentTime = trimEnd;
                  element.pause();
                  setCurrentTime(trimEnd);
                  return;
                }

                setCurrentTime(element.currentTime);
              }}
              muted={Boolean(media.audioTracks.length)}
              playsInline
              preload="auto"
              ref={videoRef}
              src={media.fileUrl}
            />
          ) : (
            <div className="viewport-empty" aria-hidden="true" />
          )}
        </div>

        <button
          className={`timeline-divider-handle${resizingTimeline ? " is-active" : ""}`}
          {...bindTooltip(resizeTimelineTooltip, {
            keepVisible: () => resizingTimeline,
            placement: "below",
          })}
          onPointerDown={(event) => {
            dividerDragRef.current = {
              startY: event.clientY,
              startHeight: timelineHeight,
            };
            setResizingTimeline(true);
            showTooltip(resizeTimelineTooltip, event.clientX, event.clientY, "below");
          }}
          type="button"
        >
          <span className="sr-only">{resizeTimelineTooltip}</span>
        </button>

        <div className={`timeline-shell${timelineExpanded ? " is-expanded" : ""}`} onClick={(event) => event.stopPropagation()}>
          <div className={`timeline-header${media ? "" : " timeline-header-idle"}`} ref={timelineHeaderRef}>
            <div className="timeline-header-gutter" />
            <div
              className="timeline-header-content"
              onPointerDown={(event) => {
                if (!media) {
                  return;
                }

                seekFromPointer(event.clientX);
              }}
              ref={timelineRef}
            >
              <div className="timeline-track" />
              {media ? (
                <div aria-hidden="true" className="timeline-ruler">
                  {rulerTicks.map((tick) => (
                    <div className="timeline-ruler-tick" key={`${tick.left}-${tick.label}`} style={{ left: tick.left }}>
                      <span className="timeline-ruler-label">{tick.label}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div
                className={`trim-selection${media ? "" : " trim-selection-idle"}`}
                style={{
                  left: trimLeft,
                  width: trimWidth,
                }}
              >
                <div className="trim-window" />

                {media ? (
                  <>
                    <button
                      className={`trim-handle trim-handle-start${dragMode === "start" ? " is-active" : ""}`}
                      {...bindTooltip(trimStartTooltip, {
                        keepVisible: () => dragMode === "start",
                      })}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDragMode("start");
                        showTooltip(trimStartTooltip, event.clientX, event.clientY);
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const nextTrimStart = Math.min(currentTime, trimEnd - MIN_TRIM_GAP);
                        setTrimStart(nextTrimStart);
                        showTooltip(`Start ${formatTimecode(nextTrimStart)}`, event.clientX, event.clientY);
                      }}
                      type="button"
                    >
                      <span className="sr-only">{trimStartTooltip}</span>
                    </button>

                    <button
                      className={`trim-handle trim-handle-end${dragMode === "end" ? " is-active" : ""}`}
                      {...bindTooltip(trimEndTooltip, {
                        keepVisible: () => dragMode === "end",
                      })}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setDragMode("end");
                        showTooltip(trimEndTooltip, event.clientX, event.clientY);
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const nextTrimEnd = Math.max(currentTime, trimStart + MIN_TRIM_GAP);
                        setTrimEnd(nextTrimEnd);
                        showTooltip(`End ${formatTimecode(nextTrimEnd)}`, event.clientX, event.clientY);
                      }}
                      type="button"
                    >
                      <span className="sr-only">{trimEndTooltip}</span>
                    </button>
                  </>
                ) : null}
              </div>

              {media ? <div className="playhead" style={{ left: playheadLeft }} /> : null}
            </div>
          </div>

          <div className="timeline-body">
            {media ? (
              <div className="timeline-lanes">
                <div className="timeline-lane">
                  <div className="timeline-lane-label">V1</div>
                  <div
                    className="timeline-lane-content timeline-lane-video"
                    onPointerDown={(event) => seekFromPointer(event.clientX)}
                  >
                    <div className="timeline-thumb-strip">
                      {media.thumbnails.map((thumbnail, index) => (
                        <div
                          className="timeline-thumb-cell"
                          key={`${index}-${thumbnail.slice(0, 18)}`}
                          style={{ backgroundImage: `url(${thumbnail})` }}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                {media.audioTracks.map((track, index) => {
                  const trackDb = trackVolumeDb[track.id] ?? gainToDb(track.volume);
                  const trackMuted = isMutedVolumeDb(trackDb);
                  const trackTooltip = `A${index + 1} ${trackMuted ? "Muted" : formatDbLabel(trackDb)}`;

                  return (
                    <div className={`timeline-lane${trackMuted ? " timeline-lane-muted" : ""}`} key={track.id}>
                      <div className="timeline-lane-label timeline-lane-label-audio">
                        <span className="timeline-lane-id">A{index + 1}</span>
                      </div>
                      <div
                        className="timeline-lane-content timeline-lane-audio"
                        onPointerDown={(event) => seekFromPointer(event.clientX)}
                      >
                        <AudioLaneWaveform track={track} volumeGain={dbToGain(trackDb)} muted={trackMuted} />
                        <button
                          className={`timeline-volume-handle${volumeDrag?.trackId === track.id ? " is-active" : ""}${trackMuted ? " is-muted" : ""}`}
                          {...bindTooltip(trackTooltip, {
                            keepVisible: () => volumeDrag?.trackId === track.id,
                          })}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const rect = event.currentTarget.parentElement?.getBoundingClientRect();

                            if (!rect) {
                              return;
                            }

                            setVolumeDrag({
                              label: `A${index + 1}`,
                              trackId: track.id,
                              top: rect.top,
                              height: rect.height,
                            });
                            setTrackVolumeDb((current) => ({
                              ...current,
                              [track.id]: clientYToVolumeDb(event.clientY, rect.top, rect.height),
                            }));
                            showTooltip(trackTooltip, event.clientX, event.clientY);
                          }}
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setTrackVolumeDb((current) => ({
                              ...current,
                              [track.id]: 0,
                            }));
                            showTooltip(`A${index + 1} 0 dB`, event.clientX, event.clientY);
                          }}
                          style={{
                            top: `${volumeDbToPercent(trackDb)}%`,
                          }}
                          type="button"
                        >
                          <span className="sr-only">{trackTooltip}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div className="timeline-body-overlay">
                  <div
                    className="timeline-body-selection"
                    style={{
                      left: trimLeft,
                      width: trimWidth,
                    }}
                  />
                  <div className="timeline-body-playhead" style={{ left: playheadLeft }} />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <footer className={`clip-stats-footer${exporting ? " is-exporting" : ""}`}>
          {errorMessage && !exporting ? (
            <div aria-live="assertive" className="footer-status footer-status-error" role="status">
              <span className="footer-status-label">Error</span>
              <span className="footer-status-message">{errorMessage}</span>
              <button
                className="footer-status-dismiss"
                onClick={() => {
                  setErrorMessage(null);
                }}
                type="button"
              >
                Dismiss
              </button>
            </div>
          ) : media ? (
            exporting ? (
              <div aria-live="polite" className="export-progress-shell">
                <div className="export-progress-meta">
                  <span className="export-progress-label">{exportProgressLabel}</span>
                  <span className="export-progress-eta">{exportEtaLabel}</span>
                </div>
                <div aria-hidden="true" className="export-progress-track">
                  <div
                    className="export-progress-fill"
                    style={{
                      transform: `scaleX(${exportProgressValue})`,
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="clip-stats-grid">
                {clipStats.map((stat) => (
                  <div className="clip-stat-card" key={stat.label}>
                    <span className="clip-stat-label">{stat.label}</span>
                    <strong className="clip-stat-value">{stat.value}</strong>
                  </div>
                ))}
              </div>
            )
          ) : null}
        </footer>
      </section>
      {renderedTooltip ? (
        <div
          aria-hidden="true"
          className={`floating-tooltip floating-tooltip-${tooltipPosition?.placement ?? renderedTooltip.placement}${tooltipVisible ? " is-visible" : ""}${renderedTooltip.motion === "bob" ? " floating-tooltip-bob" : ""}`}
          ref={tooltipRef}
          style={{
            ["--tooltip-arrow-left" as string]: `${tooltipPosition?.arrowLeft ?? 0}px`,
            left: tooltipPosition?.left ?? -9999,
            top: tooltipPosition?.top ?? -9999,
          }}
        >
          {renderedTooltip.label}
        </div>
      ) : null}
    </main>
  );
}
