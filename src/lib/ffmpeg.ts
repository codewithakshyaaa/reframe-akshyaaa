import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import {
  EditRecipe,
  ExportResult,
  BackgroundMusicOptions,
  ImageOverlayOptions,
} from "./types";
import { getPresetById } from "./presets";
import { simd } from "wasm-feature-detect";

// ─── CDN base URLs ────────────────────────────────────────────────────────────
const CORE_VERSION = "0.12.10";
const BASE_ST = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

// MT build served locally from public/ffmpeg-mt-umd/
// Copied from node_modules/@ffmpeg/core-mt/dist/umd
const BASE_MT = `/ffmpeg-mt-umd`;

const SRI_HASHES: Record<string, string> = {
  // Single-thread build (CDN) — SRI verified
  "ffmpeg-core.js":
    "sha384-sKfkiFtvUk+vexk+0EUhEh366190/4WpgUAsUvaxEfyg7+E1Zt5Y5hrsU808g8Q9",
  "ffmpeg-core.wasm":
    "sha384-U1VDhkPYrM3wTCT4/vjSpSsKqG/UjljYrYCI4hBSJ02svbCkxuCi6U6u/peg5vpW",

  // Multi-thread build (local) — no SRI needed for same-origin files
  "ffmpeg-core-mt.js": "",
  "ffmpeg-core-mt.wasm": "",
  "ffmpeg-core-mt.worker.js": "",
};

// ─── Capability detection ─────────────────────────────────────────────────────

function hasSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== "undefined";
}

async function pickCoreBuild(): Promise<{
  baseUrl: string;
  coreFile: string;
  wasmFile: string;
  workerFile?: string;
  isMultiThread: boolean;
}> {
  // FIX #1: was `share` (undefined variable) — now correctly calls hasSharedArrayBuffer()
  const canUseSAB = hasSharedArrayBuffer();
  const canUseSIMD = await simd();

  console.info(
    `[FFmpeg] Capabilities — SharedArrayBuffer: ${canUseSAB}, SIMD: ${canUseSIMD}`
  );

  if (canUseSAB) {
    console.info("[FFmpeg] Selecting multi-thread (MT) build");
    return {
      baseUrl: BASE_MT,
      coreFile: "ffmpeg-core-mt.js",
      wasmFile: "ffmpeg-core-mt.wasm",
      workerFile: "ffmpeg-core-mt.worker.js",
      isMultiThread: true,
    };
  }

  console.info("[FFmpeg] Selecting single-thread (ST) build");
  return {
    baseUrl: BASE_ST,
    coreFile: "ffmpeg-core.js",
    wasmFile: "ffmpeg-core.wasm",
    isMultiThread: false,
  };
}

// ─── Secure binary fetch ──────────────────────────────────────────────────────

// FIX #2: Same-origin (local) files don't need SRI — skip integrity check for them
async function fetchWithIntegrity(
  url: string,
  mimeType: string
): Promise<string> {
  const key = url.split("/").pop()!;
  const integrity = SRI_HASHES[key];

  if (integrity === undefined) {
    throw new Error(
      `[SRI] No hash registered for: ${key} — add it to SRI_HASHES in ffmpeg.ts`
    );
  }

  // Local/same-origin files — direct URL return karo, blob mat banao
  // Blob URLs + COEP = worker importScripts fail
  if (integrity.length === 0) {
    return url;
  }

  // CDN files — SRI verify karo
  const res = await fetch(url, { integrity, credentials: "omit" });
  if (!res.ok) {
    throw new Error(
      `[SRI] Fetch failed for ${key}: HTTP ${res.status} ${res.statusText}`
    );
  }

  const blob = new Blob([await res.arrayBuffer()], { type: mimeType });
  return URL.createObjectURL(blob);
}
// ─── Singleton FFmpeg instance ────────────────────────────────────────────────

let ffmpegInstance: FFmpeg | null = null;
let loadedBuildIsMultiThread: boolean | null = null;

export class FFmpegLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FFmpegLoadError";
  }
}

async function tryLoadBuild(
  ffmpeg: FFmpeg,
  build: Awaited<ReturnType<typeof pickCoreBuild>>,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    if (build.isMultiThread) {
      await ffmpeg.load(
        {
          coreURL: await fetchWithIntegrity(
            `${build.baseUrl}/${build.coreFile}`,
            "text/javascript"
          ),
          wasmURL: await fetchWithIntegrity(
            `${build.baseUrl}/${build.wasmFile}`,
            "application/wasm"
          ),
          workerURL: await fetchWithIntegrity(
            `${build.baseUrl}/${build.workerFile!}`,
            "text/javascript"
          ),
        },
        { signal }
      );
    } else {
      await ffmpeg.load(
        {
          coreURL: await fetchWithIntegrity(
            `${build.baseUrl}/${build.coreFile}`,
            "text/javascript"
          ),
          wasmURL: await fetchWithIntegrity(
            `${build.baseUrl}/${build.wasmFile}`,
            "application/wasm"
          ),
        },
        { signal }
      );
    }
    return true;
  } catch (err) {
    if (
      signal?.aborted ||
      (err instanceof DOMException && err.name === "AbortError")
    ) {
      throw err;
    }
    console.warn("[FFmpeg] Build load failed:", err);
    return false;
  }
}

export async function loadFFmpeg(
  signal?: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    onProgress?.(100);
    return ffmpegInstance;
  }

  const ffmpeg = ffmpegInstance ?? new FFmpeg();
  ffmpegInstance = ffmpeg;

  const handleProgress = ({ progress }: { progress: number }) => {
    onProgress?.(Math.round(progress * 100));
  };
  ffmpeg.on("progress", handleProgress);

  try {
    const preferredBuild = await pickCoreBuild();
    const loaded = await tryLoadBuild(ffmpeg, preferredBuild, signal);

    if (loaded) {
      loadedBuildIsMultiThread = preferredBuild.isMultiThread;
      console.info(
        `[FFmpeg] Loaded ${
          preferredBuild.isMultiThread
            ? "multi-thread (MT)"
            : "single-thread (ST)"
        } build successfully`
      );
      onProgress?.(100);
      return ffmpeg;
    }

    // FIX #3: Always try ST fallback regardless of what preferred build was
    if (preferredBuild.isMultiThread) {
      console.warn(
        "[FFmpeg] Multi-thread build failed to load. Retrying with single-thread fallback."
      );
    }

    const stBuild = {
      baseUrl: BASE_ST,
      coreFile: "ffmpeg-core.js",
      wasmFile: "ffmpeg-core.wasm",
      isMultiThread: false as const,
    };

    const stLoaded = await tryLoadBuild(ffmpeg, stBuild, signal);
    if (stLoaded) {
      loadedBuildIsMultiThread = false;
      console.info("[FFmpeg] Loaded single-thread (ST) build via fallback.");
      onProgress?.(100);
      return ffmpeg;
    }

    throw new FFmpegLoadError(
      "Failed to load the FFmpeg engine. Check your internet connection and try again."
    );
  } catch (err) {
    if (err instanceof FFmpegLoadError) throw err;

    if (ffmpegInstance === ffmpeg) {
      ffmpegInstance = null;
      loadedBuildIsMultiThread = null;
    }

    const wasCancelled =
      signal?.aborted ||
      (err instanceof DOMException && err.name === "AbortError");

    if (wasCancelled) throw err;

    throw new FFmpegLoadError(
      "Failed to load the FFmpeg engine. Check your internet connection and try again."
    );
  } finally {
    ffmpeg.off("progress", handleProgress);
  }
}

export function terminateFFmpeg() {
  ffmpegInstance?.terminate();
  ffmpegInstance = null;
  loadedBuildIsMultiThread = null;
}

// ─── Session ID ───────────────────────────────────────────────────────────────

function buildSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ─── Filter builders ──────────────────────────────────────────────────────────

function buildVideoFilter(
  recipe: EditRecipe,
  targetW: number,
  targetH: number
): string {
  const filters: string[] = [];

  if (recipe.trimStart > 0 || recipe.trimEnd !== null) {
    const end = recipe.trimEnd !== null ? recipe.trimEnd : 999999;
    filters.push(`trim=start=${recipe.trimStart}:end=${end}`);
    filters.push("setpts=PTS-STARTPTS");
  }

  if (recipe.stabilization) {
    filters.push("deshake");
  }

  if (recipe.rotate === 90) {
    filters.push("transpose=1");
  } else if (recipe.rotate === 180) {
    filters.push("transpose=1,transpose=1");
  } else if (recipe.rotate === 270) {
    filters.push("transpose=2");
  }

  if (recipe.framing === "fit") {
    filters.push(
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`,
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=black`
    );
  } else {
    filters.push(
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase`,
      `crop=${targetW}:${targetH}`
    );
  }

  if (recipe.speed !== 1) {
    const pts = (1 / recipe.speed).toFixed(4);
    filters.push(`setpts=${pts}*PTS`);
  }

  filters.push(
    `eq=brightness=${recipe.brightness}:contrast=${recipe.contrast}:saturation=${recipe.saturation}`
  );

  return filters.join(",");
}

export function buildAudioFilter(
  speed: number,
  normalizeAudio: boolean
): string {
  const filters: string[] = [];

  let remaining = speed;
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  while (remaining > 2.0) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }
  if (Math.abs(remaining - 1.0) > 0.001) {
    filters.push(`atempo=${Number(remaining.toFixed(4))}`);
  }

  if (normalizeAudio) filters.push("loudnorm=I=-14:TP=-1.5:LRA=11");

  return filters.join(",");
}

function buildAudioTrimFilter(recipe: EditRecipe): string {
  if (recipe.trimStart === 0 && recipe.trimEnd === null) return "";
  const end = recipe.trimEnd !== null ? recipe.trimEnd : 999999;
  return `atrim=start=${recipe.trimStart}:end=${end},asetpts=PTS-STARTPTS`;
}

// ─── Argument builder ─────────────────────────────────────────────────────────

function buildArguments(
  recipe: EditRecipe,
  format: "mp4" | "webm" | "mkv" | "gif",
  outputName: string,
  inputName: string,
  targetW: number,
  targetH: number,
  hasMusicTrack: boolean,
  musicInputName: string,
  musicOptions: BackgroundMusicOptions | undefined,
  hasOverlay: boolean,
  overlayInputName: string,
  overlayOptions: ImageOverlayOptions | undefined,
  hasOriginalAudio: boolean
): string[] {
  const vf = buildVideoFilter(recipe, targetW, targetH);
  const audioTrim = hasOriginalAudio ? buildAudioTrimFilter(recipe) : "";
  const audioSpeed = hasOriginalAudio
    ? buildAudioFilter(recipe.speed, recipe.normalizeAudio ?? false)
    : "";
  const afParts = [audioTrim, audioSpeed].filter(Boolean);
  const af = afParts.join(",");

  const musicIdx = 1;
  const overlayIdx = hasMusicTrack ? 2 : 1;

  const args: string[] = [];
  args.push("-i", inputName);

  if (hasMusicTrack) {
    if (musicOptions!.loopMusic) args.push("-stream_loop", "-1");
    args.push("-i", musicInputName);
  }
  if (hasOverlay) {
    args.push("-i", overlayInputName);
  }

  const needsFilterComplex = hasOverlay || hasMusicTrack;
  const shouldKeepAudio = recipe.keepAudio && (hasOriginalAudio || hasMusicTrack);

  if (needsFilterComplex) {
    const filterParts: string[] = [];
    let videoOut = "[0:v]";

    if (vf) {
      filterParts.push(`[0:v]${vf}[vbase]`);
      videoOut = "[vbase]";
    }

    if (hasOverlay) {
      const scaledW = overlayOptions!.size;
      const alpha = (overlayOptions!.opacity / 100).toFixed(2);
      const posMap: Record<string, string> = {
        "top-left": "20:20",
        "top-right": "W-w-20:20",
        "bottom-left": "20:H-h-20",
        "bottom-right": "W-w-20:H-h-20",
      };
      const pos = posMap[overlayOptions!.position] ?? "W-w-20:H-h-20";
      filterParts.push(
        `[${overlayIdx}:v]scale=${scaledW}:-2,format=rgba,colorchannelmixer=aa=${alpha}[logo]`
      );
      filterParts.push(`${videoOut}[logo]overlay=${pos}[vout]`);
      videoOut = "[vout]";
    }

    let audioOut = "";
    if (shouldKeepAudio) {
      if (hasMusicTrack) {
        const musicVol = (musicOptions!.musicVolume / 100).toFixed(2);
        if (hasOriginalAudio) {
          const origVol = (musicOptions!.originalAudioVolume / 100).toFixed(2);
          const origChain =
            afParts.length > 0
              ? `[0:a]${afParts.join(",")},volume=${origVol}[orig]`
              : `[0:a]volume=${origVol}[orig]`;
          filterParts.push(origChain);
          filterParts.push(`[${musicIdx}:a]volume=${musicVol}[music]`);
          filterParts.push(
            `[orig][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`
          );
          audioOut = "[aout]";
        } else {
          filterParts.push(`[${musicIdx}:a]volume=${musicVol}[aout]`);
          audioOut = "[aout]";
        }
      } else if (hasOriginalAudio && af) {
        filterParts.push(`[0:a]${af}[aout]`);
        audioOut = "[aout]";
      }
    }

    if (filterParts.length > 0) {
      args.push("-filter_complex", filterParts.join(";"));
    }
    args.push("-map", videoOut === "[0:v]" ? "0:v" : videoOut);

    if (!shouldKeepAudio) {
      args.push("-an");
    } else if (audioOut) {
      args.push("-map", audioOut);
    } else if (hasOriginalAudio) {
      args.push("-map", "0:a");
    }
  } else {
    if (vf) args.push("-vf", vf);
    if (!shouldKeepAudio) {
      args.push("-an");
    } else if (af && hasOriginalAudio) {
      args.push("-af", af);
    }
  }

  // FIX #4: Added -y flag to all formats to allow overwrite without prompt
  if (format === "webm") {
    args.push("-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(recipe.quality));
    if (shouldKeepAudio) args.push("-c:a", "libopus");
  } else if (format === "mkv") {
    args.push(
      "-c:v", "libx264", "-crf", String(recipe.quality), "-preset", "medium"
    );
    if (shouldKeepAudio) args.push("-c:a", "aac", "-b:a", "128k");
  } else {
    args.push(
      "-c:v", "libx264",
      "-crf", String(recipe.quality),
      "-preset", "medium",
      "-movflags", "+faststart"
    );
    if (shouldKeepAudio) args.push("-c:a", "aac", "-b:a", "128k");
  }

  args.push("-y", outputName);
  return args;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function exportVideo(
  ffmpeg: FFmpeg,
  file: File,
  recipe: EditRecipe,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
  musicOptions?: BackgroundMusicOptions,
  overlayOptions?: ImageOverlayOptions
): Promise<ExportResult> {
  // ── BENCHMARK ──────────────────────────────────────────────────────────────
  const _buildLabel = loadedBuildIsMultiThread
    ? "MT (multi-thread)"
    : "ST (single-thread)";
  const _exportStart = performance.now();
  console.info(
    "%c[FFmpeg Benchmark] Export started",
    "color:#1D9E75;font-weight:bold"
  );
  console.info(
    `%c[FFmpeg Benchmark] Build  : ${_buildLabel}`,
    "color:#1D9E75"
  );
  console.info(
    `%c[FFmpeg Benchmark] File   : ${file.name} (${(
      file.size /
      1024 /
      1024
    ).toFixed(2)} MB)`,
    "color:#1D9E75"
  );
  console.info(
    `%c[FFmpeg Benchmark] Format : ${recipe.format} | CRF: ${recipe.quality}`,
    "color:#1D9E75"
  );
  // ──────────────────────────────────────────────────────────────────────────

  const sessionId = buildSessionId();

  let targetW: number, targetH: number;
  if (recipe.preset === "custom") {
    targetW = recipe.customWidth;
    targetH = recipe.customHeight;
  } else {
    const preset = getPresetById(recipe.preset);
    targetW = preset?.width ?? 1920;
    targetH = preset?.height ?? 1080;
  }

  targetW = Math.round(targetW / 2) * 2;
  targetH = Math.round(targetH / 2) * 2;

  const ext = file.name.split(".").pop() ?? "mp4";
  const inputName = `input_${sessionId}.${ext}`;

  const getOutputConfig = (format: string) => {
    switch (format) {
      case "webm":
        return { filename: `output_${sessionId}.webm`, mimeType: "video/webm" };
      case "mkv":
        return {
          filename: `output_${sessionId}.mkv`,
          mimeType: "video/x-matroska",
        };
      case "gif":
        return { filename: `output_${sessionId}.gif`, mimeType: "image/gif" };
      default:
        return { filename: `output_${sessionId}.mp4`, mimeType: "video/mp4" };
    }
  };

  const { filename: outputName, mimeType } = getOutputConfig(recipe.format);
  const fallbackOutputName = `fallback_${sessionId}.webm`;
  const paletteName = `palette_${sessionId}.png`;
  const cleanupFiles = new Set<string>([
    inputName,
    outputName,
    fallbackOutputName,
    paletteName,
  ]);

  const handleProgress = ({ progress }: { progress: number }) => {
    onProgress(Math.min(99, Math.round(progress * 100)));
  };

  const logBenchmarkDone = (format: string) => {
    const ms = performance.now() - _exportStart;
    const sec = (ms / 1000).toFixed(2);
    console.info(
      "%c[FFmpeg Benchmark] Export finished",
      "color:#1D9E75;font-weight:bold"
    );
    console.info(
      `%c[FFmpeg Benchmark] Build      : ${_buildLabel}`,
      "color:#1D9E75"
    );
    console.info(
      `%c[FFmpeg Benchmark] Output fmt : ${format}`,
      "color:#1D9E75"
    );
    console.info(
      `%c[FFmpeg Benchmark] Total time : ${sec}s`,
      "color:#0F6E56;font-weight:bold;font-size:14px"
    );
  };

  // FIX #5: logListener declared outside try so finally block can always remove it
  const logListener = ({ message }: { message: string }) => {
    const msg = message.toLowerCase();
    if (
      msg.includes("matches no streams") ||
      msg.includes("specifier '0:a'") ||
      msg.includes("input pad 0 on filter src")
    ) {
      missingAudioDetected = true;
    }
  };

  let missingAudioDetected = false;

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file), { signal });

    const hasMusicTrack = !!(musicOptions?.file && recipe.keepAudio);
    const musicInputName = `music_input_${sessionId}.mp3`;
    if (hasMusicTrack) {
      await ffmpeg.writeFile(
        musicInputName,
        await fetchFile(musicOptions!.file!),
        { signal }
      );
      cleanupFiles.add(musicInputName);
    }

    const hasOverlay = !!(overlayOptions?.file);
    const overlayExt = overlayOptions?.file?.name.split(".").pop() ?? "png";
    const overlayInputName = `overlay_${sessionId}.${overlayExt}`;
    if (hasOverlay) {
      await ffmpeg.writeFile(
        overlayInputName,
        await fetchFile(overlayOptions!.file!),
        { signal }
      );
      cleanupFiles.add(overlayInputName);
    }

    ffmpeg.on("progress", handleProgress);
    ffmpeg.on("log", logListener);

    // ── Two-pass GIF export ──────────────────────────────────────────────────
    if (recipe.format === "gif") {
      const vf = buildVideoFilter(recipe, targetW, targetH);
      const vfWithPalette = vf ? `${vf},palettegen` : "palettegen";
      const vfWithPaletteUse = vf
        ? `[0:v]${vf}[x];[x][1:v]paletteuse`
        : "[0:v][1:v]paletteuse";

      const pass1Code = await ffmpeg.exec(
        ["-i", inputName, "-vf", vfWithPalette, "-y", paletteName],
        undefined,
        { signal }
      );
      if (pass1Code !== 0) throw new Error("GIF palette generation failed");

      const pass2Code = await ffmpeg.exec(
        [
          "-i", inputName,
          "-i", paletteName,
          "-lavfi", vfWithPaletteUse,
          "-y", outputName,
        ],
        undefined,
        { signal }
      );
      if (pass2Code !== 0) throw new Error("GIF export failed");

      const data = await ffmpeg.readFile(outputName, undefined, { signal });
      const blob = new Blob([new Uint8Array(data as Uint8Array)], {
        type: "image/gif",
      });

      onProgress(100);
      logBenchmarkDone("gif");
      return {
        blobUrl: URL.createObjectURL(blob),
        size: blob.size,
        width: targetW,
        height: targetH,
        format: "gif" as const,
      };
    }
    // ────────────────────────────────────────────────────────────────────────

    // Attempt 1 — standard export
    let args = buildArguments(
      recipe, recipe.format, outputName, inputName, targetW, targetH,
      hasMusicTrack, musicInputName, musicOptions,
      hasOverlay, overlayInputName, overlayOptions, true
    );
    let exitCode = await ffmpeg.exec(args, undefined, { signal });

    // Attempt 2 — auto-recover if file had no audio track
    if (exitCode !== 0 && missingAudioDetected) {
      missingAudioDetected = false;
      args = buildArguments(
        recipe, recipe.format, outputName, inputName, targetW, targetH,
        hasMusicTrack, musicInputName, musicOptions,
        hasOverlay, overlayInputName, overlayOptions, false
      );
      exitCode = await ffmpeg.exec(args, undefined, { signal });
    }

    // Attempt 3 — switch to WebM fallback
    if (exitCode !== 0) {
      args = buildArguments(
        recipe, "webm", fallbackOutputName, inputName, targetW, targetH,
        hasMusicTrack, musicInputName, musicOptions,
        hasOverlay, overlayInputName, overlayOptions, !missingAudioDetected
      );
      const fallbackCode = await ffmpeg.exec(args, undefined, { signal });
      if (fallbackCode !== 0) throw new Error("Export failed");

      const data = await ffmpeg.readFile(fallbackOutputName, undefined, {
        signal,
      });
      const blob = new Blob([new Uint8Array(data as Uint8Array)], {
        type: "video/webm",
      });

      onProgress(100);
      logBenchmarkDone("webm (fallback)");
      return {
        blobUrl: URL.createObjectURL(blob),
        size: blob.size,
        width: targetW,
        height: targetH,
        format: "webm",
      };
    }

    const data = await ffmpeg.readFile(outputName, undefined, { signal });
    const blob = new Blob([new Uint8Array(data as Uint8Array)], {
      type: mimeType,
    });

    onProgress(100);
    logBenchmarkDone(recipe.format);
    return {
      blobUrl: URL.createObjectURL(blob),
      size: blob.size,
      width: targetW,
      height: targetH,
      format: recipe.format as "mp4" | "webm" | "mkv",
    };
  } finally {
    // FIX #6: ALL listeners cleaned up in finally — no leaks on success, error, or cancel
    ffmpeg.off("progress", handleProgress);
    ffmpeg.off("log", logListener);

    for (const path of cleanupFiles) {
      try {
        await ffmpeg.deleteFile(path);
      } catch {
        // ignore — file may not exist if export failed early
      }
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}