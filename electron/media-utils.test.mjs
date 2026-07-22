import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildExportArgs, normalizeWaveform } = require("./media-utils.cjs");

const baseExport = {
  duration: 12.5,
  outputPath: "C:/clips/out.mp4",
  sourcePath: "C:/clips/input.mkv",
  startTime: 4,
};

function argsFor(trackVolumes, fallbackEncode = false, preciseExport = false) {
  return buildExportArgs({
    ...baseExport,
    fallbackEncode,
    preciseExport,
    trackVolumes,
  });
}

describe("buildExportArgs", () => {
  it("omits muted tracks from the audio filter graph", () => {
    const args = argsFor([
      { audioIndex: 0, trackId: "audio-0", volume: 1 },
      { audioIndex: 1, trackId: "audio-1", volume: 0 },
    ]);

    expect(args.join(" ")).toContain("[0:a:0]");
    expect(args.join(" ")).not.toContain("[0:a:1]");
    expect(args).toContain("-c:a");
  });

  it("exports one remaining track as one AAC stereo track", () => {
    const args = argsFor([{ audioIndex: 2, trackId: "audio-2", volume: 0.5 }]);
    const joined = args.join(" ");

    expect(joined).toContain("[0:a:2]");
    expect(joined).not.toContain("amix=");
    expect(args).toContain("[a0]");
    expect(args).toContain("-ac");
    expect(args).toContain("2");
  });

  it("mixes multiple audible tracks into one output", () => {
    const args = argsFor([
      { audioIndex: 0, trackId: "audio-0", volume: 1 },
      { audioIndex: 1, trackId: "audio-1", volume: 0.8 },
    ]);

    expect(args.join(" ")).toContain("amix=inputs=2");
    expect(args).toContain("[amixout]");
  });

  it("exports video only when all tracks are muted", () => {
    const args = argsFor([{ audioIndex: 0, trackId: "audio-0", volume: 0 }]);

    expect(args).toContain("-an");
    expect(args).not.toContain("-filter_complex");
  });

  it("uses output seeking and re-encodes video for exact default trims", () => {
    const args = argsFor([]);

    expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf(baseExport.sourcePath));
    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    expect(args).toContain("fast");
  });

  it("uses libx264 for the compatibility fallback path", () => {
    const args = argsFor([], true);

    expect(args).toContain("-c:v");
    expect(args).toContain("libx264");
    expect(args).toContain("veryfast");
  });

  it("uses filter trimming and higher quality encoding for precise export", () => {
    const fastArgs = argsFor([]);
    const preciseArgs = argsFor([], false, true);
    const preciseJoined = preciseArgs.join(" ");

    expect(fastArgs).toContain("fast");
    expect(fastArgs).not.toContain("slow");
    expect(preciseArgs).toContain("slow");
    expect(preciseArgs).not.toContain("fast");
    expect(preciseArgs).toContain("16");
    expect(preciseArgs).not.toContain("-ss");
    expect(preciseJoined).toContain("trim=start=4.000000:duration=12.500000,setpts=PTS-STARTPTS[v0]");
  });

  it("trims precise audio before mixing", () => {
    const args = argsFor(
      [
        { audioIndex: 0, trackId: "audio-0", volume: 1 },
        { audioIndex: 1, trackId: "audio-1", volume: 0.8 },
      ],
      false,
      true,
    );
    const joined = args.join(" ");

    expect(joined).toContain("[0:a:0]atrim=start=4.000000:duration=12.500000,asetpts=PTS-STARTPTS");
    expect(joined).toContain("[0:a:1]atrim=start=4.000000:duration=12.500000,asetpts=PTS-STARTPTS");
    expect(joined).toContain("amix=inputs=2");
  });
});

describe("normalizeWaveform", () => {
  it("returns an empty waveform for empty input", () => {
    expect(normalizeWaveform([], 100)).toEqual([]);
  });

  it("does not create NaN buckets for tiny clips", () => {
    const samples = normalizeWaveform([0.2, -0.6], 1400);

    expect(samples).toEqual([0.2, 0.6]);
    expect(samples.every(Number.isFinite)).toBe(true);
  });

  it("downsamples normal waveforms into finite peak buckets", () => {
    const samples = normalizeWaveform([0, -0.25, 0.5, -1, 0.75, 0.1], 3);

    expect(samples).toEqual([0.25, 1, 0.75]);
    expect(samples.every(Number.isFinite)).toBe(true);
  });
});
