import type { ExportPayload, ExportProgress, MediaProject } from "./types";

declare global {
  interface Window {
    videoApp: {
      openVideo: () => Promise<MediaProject | null>;
      analyzeVideo: (filePath: string) => Promise<MediaProject>;
      exportClip: (
        payload: ExportPayload,
      ) => Promise<{ canceled: boolean; outputPath?: string }>;
      releaseMediaSession: (sessionId: string) => Promise<void>;
      onExportProgress: (callback: (progress: ExportProgress) => void) => () => void;
      minimizeWindow: () => Promise<void>;
      toggleMaximizeWindow: () => Promise<{ isMaximized: boolean }>;
      closeWindow: () => Promise<void>;
      getWindowState: () => Promise<{ isMaximized: boolean }>;
      onWindowStateChange: (
        callback: (state: { isMaximized: boolean }) => void,
      ) => () => void;
      onOpenFileRequested: (callback: (filePath: string) => void) => () => void;
    };
  }
}

export {};
