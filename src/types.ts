export type WaveformLevel = {
  bucketCount: number;
  samples: number[];
};

export type AudioTrack = {
  id: string;
  audioIndex: number;
  sourceIndex: number;
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
  sessionId: string | null;
  duration: number;
  fps: number;
  width: number;
  height: number;
  thumbnails: string[];
  audioTracks: AudioTrack[];
};

export type ExportPayload = {
  sourcePath: string;
  fileName: string;
  startTime: number;
  endTime: number;
  trackVolumes: Array<{
    audioIndex: number;
    volume: number;
  }>;
};

export type ExportProgress = {
  progress: number;
  processedSeconds: number;
  totalSeconds: number;
  etaSeconds: number | null;
  speed: number | null;
};
