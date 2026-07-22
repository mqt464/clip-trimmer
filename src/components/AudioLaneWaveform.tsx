import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { AudioTrack } from "../types";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

export function AudioLaneWaveform({
  track,
  mediaDuration,
  volumeGain,
  muted,
}: {
  track: AudioTrack;
  mediaDuration: number;
  volumeGain: number;
  muted: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformColor = muted ? "rgba(159, 167, 179, 0.68)" : "rgba(81, 226, 132, 0.9)";
  const safeMediaDuration = Math.max(mediaDuration, 0.001);
  const trackStart = clamp(track.startTime, 0, safeMediaDuration);
  const trackDuration = clamp(track.duration, 0, safeMediaDuration - trackStart);
  const waveformStyle = {
    left: `${(trackStart / safeMediaDuration) * 100}%`,
    width: `${(trackDuration / safeMediaDuration) * 100}%`,
  } satisfies CSSProperties;

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
    <div className="timeline-waveform" style={waveformStyle}>
      <canvas aria-hidden="true" className="timeline-waveform-canvas" ref={canvasRef} />
    </div>
  );
}
