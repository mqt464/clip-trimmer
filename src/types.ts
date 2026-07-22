export type WaveformLevel = {
  bucketCount: number;
  samples: number[];
};

export type AudioTrack = {
  id: string;
  audioIndex: number;
  sourceIndex: number;
  startTime: number;
  duration: number;
  audioUrl: string;
  label: string;
  channels: number;
  codecName: string;
  language: string | null;
  title: string | null;
  volume: number;
  samples: number[];
  waveformLevels: WaveformLevel[];
};

export type MediaProject = {
  filePath: string;
  fileUrl: string;
  fileName: string;
  fileSizeBytes: number;
  sessionId: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  thumbnails: string[];
  audioTracks: AudioTrack[];
};

export type ExportPayload = {
  sessionId: string;
  fileName: string;
  startTime: number;
  endTime: number;
  preciseExport?: boolean;
  trackVolumes: Array<{
    trackId: string;
    volume: number;
  }>;
};

export type MediaAssetsUpdate = {
  sessionId: string;
  thumbnails?: string[];
  audioTrack?: AudioTrack;
};

export type ExportProgress = {
  progress: number;
  processedSeconds: number;
  totalSeconds: number;
  etaSeconds: number | null;
  speed: number | null;
};
