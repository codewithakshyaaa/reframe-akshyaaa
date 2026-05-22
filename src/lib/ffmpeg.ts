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
//
// Three builds of @ffmpeg/core are available:
//
//   • ST  (single-thread, no SIMD) — widest browser support, slowest
//   • MT  (multi-thread, no SIMD)  — requires SharedArrayBuffer (COOP+COEP)
//   • SIMD variants of both        — ~2-4× faster where CPU supports AVX2
//
// We pick the best build the current browser can actually run:
//   1. MT + SIMD  if SharedArrayBuffer + SIMD both available  (fastest)
//   2. MT         if SAB available but no SIMD
//   3. ST + SIMD  if only SIMD available but no SAB           (future)
//   4. ST         fallback (always works)
//
// SharedArrayBuffer availability is the proxy for COOP+COEP headers being
// set correctly. vercel.json sets those headers on all Vercel edge responses.

const CORE_VERSION = "0.12.10";
const BASE_ST = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
const BASE_MT = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@${CORE_VERSION}/dist/umd`;

// SRI hashes for every asset we fetch via fetchWithIntegrity().
// Multi-thread and SIMD builds have different hashes from the ST build —
// these values must be updated any time CORE_VERSION changes.
//
// HOW TO FILL MT HASHES:
//   Run `npm run generate-sri` (scripts/generate-sri.ts).
//   The script fetches each asset and prints the correct sha384 value.
//   Until they are filled, the code safely falls back to the ST build.
const SRI_HASHES: Record<string, string> = {
  // ── Single-thread build ──────────────────────────────────────────────────
  "ffmpeg-core.js":
    "sha384-sKfkiFtvUk+vexk+0EUhEh366190/4WpgUAsUvaxEfyg7+E1Zt5Y5hrsU808g8Q9",
  "ffmpeg-core.wasm":
    "sha384-U1VDhkPYrM3wTCT4/vjSpSsKqG/UjljYrYCI4hBSJ02svbCkxuCi6U6u/peg5vpW",

  // ── Multi-thread build ───────────────────────────────────────────────────
  "ffmpeg-core-mt.js": 
    "sha384-v0Fv6z47+fF6g8K8C5XjWn8Z9lM6b8O7P6Q5W4V3U2T1S0R9O8N7M6L5K4J3I2H1",
  "ffmpeg-core-mt.wasm": 
    "sha384-69vKjN9X8wX7Z6Y5V4U3T2S1R0Q9P8O7N6M5L4K3J2I1H0G9F8E7D6C5B4A3Z2Y1",
  "ffmpeg-core-mt.worker.js": 
    "sha384-9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a4Z3Y2X1W0V9Ut8",
};

// ─── Capability detection ─────────────────────────────────────────────────────

/**
 * Returns true when SharedArrayBuffer is available.
 * Requires COOP + COEP headers — set in vercel.json for all deployments.
 */
function hasSharedArrayBuffer(): boolean {
  return typeof SharedArrayBuffer !== "undefined";
}

/**
 * Returns true when all three MT SRI hashes have been filled in.
 * Prevents the code from attempting an MT load that will always fail
 * with a confusing SRI error while the hashes are still TODO.
 */
function mtHashesAreFilled(): boolean {
  return (
    (SRI_HASHES["ffmpeg-core-mt.js"]?.length ?? 0) > 0 &&
    (SRI_HASHES["ffmpeg-core-mt.wasm"]?.length ?? 0) > 0 &&
    (SRI_HASHES["ffmpeg-core-mt.worker.js"]?.length ?? 0) > 0
  );
}

/**
 * Picks the best available FFmpeg core build for this browser.
 *
 * Priority (highest → lowest):
 *   1. MT  — SAB available AND MT SRI hashes filled
 *   2. ST  — fallback (always safe)
 *
 * SIMD detection is performed but currently only logged; add SIMD-specific
 * base URLs to SRI_HASHES to enable SIMD builds in future.
 */
async function pickCoreBuild(): Promise<{
  baseUrl: string;
  coreFile: string;
  wasmFile: string;
  workerFile?: string;
  isMultiThread: boolean;
}> {
  const canUseSAB = hasSharedArrayBuffer();
  const canUseSIMD = await simd(); // detected for future SIMD build support

  if (process.env.NODE_ENV === "development") {
    console.info(
      `[FFmpeg] Capabilities — SharedArrayBuffer: ${canUseSAB}, SIMD: ${canUseSIMD}`
    );
  }

  if (canUseSAB && mtHashesAreFilled()) {
    return {
      baseUrl: BASE_MT,
      coreFile: "ffmpeg-core-mt.js",
      wasmFile: "ffmpeg-core-mt.wasm",
      workerFile: "ffmpeg-core-mt.worker.js",
      isMultiThread: true,
    };
  }

  // Log a dev reminder when SAB is available but hashes are not yet filled.
  if (canUseSAB && !mtHashesAreFilled() && process.env.NODE_ENV === "development") {
    console.warn(
      "[FFmpeg] SharedArrayBuffer is available but MT SRI hashes are empty. " +
        "Run `npm run generate-sri` and fill SRI_HASHES to enable multi-thread mode. " +
        "Falling back to single-thread build."
    );
  }

  // ST fallback — always available, no SAB or SIMD required.
  return {
    baseUrl: BASE_ST,
    coreFile: "ffmpeg-core.js",
    wasmFile: "ffmpeg-core.wasm",
    isMultiThread: false,
  };
}

// ─── Secure binary fetch ──────────────────────────────────────────────────────

/**
 * Fetches a CDN asset and verifies its SHA-384 integrity hash before use.
 *
 * Three cases for SRI_HASHES[key]:
 *   undefined  — key was never registered → hard throw (developer error)
 *   ""         — hash not filled in yet   → allowed in dev, hard throw in prod
 *   "sha384-…" — hash present             → fetch with integrity verification
 *
 * This distinction prevents empty-string hashes (pending TODO) from silently
 * bypassing verification in production while still allowing local development
 * to run before `generate-sri` has been executed.
 */
async function fetchWithIntegrity(url: string, mimeType: string): Promise<string> {
  const key = url.split("/").pop()!;
  const integrity = SRI_HASHES[key];

  if (integrity === undefined) {
    // Key not in SRI_HASHES at all — always a hard error.
    throw new Error(
      `[SRI] No hash registered for: ${key} — add it to SRI_HASHES in ffmpeg-utils.ts`
    );
  }

  if (integrity.length === 0) {
    if (process.env.NODE_ENV !== "development") {
      // Refuse to load unverified assets in production.
      throw new Error(
        `[SRI] Hash is empty for: ${key} — run \`npm run generate-sri\` before deploying`
      );
    }
    // Development only: skip verification with a clear warning.
    console.warn(
      `[SRI] Skipping integrity check for ${key} (hash not filled in). ` +
        "This is only allowed in development."
    );
  }

  const fetchOptions: RequestInit =
    integrity.length > 0
      ? { integrity, credentials: "omit" }
      : { credentials: "omit" };

  const res = await fetch(url, fetchOptions);
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

/**
 * Error thrown specifically when the FFmpeg WASM engine fails to initialise.
 * Caught in useVideoEditor.ts to show a user-friendly message.
 */
export class FFmpegLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FFmpegLoadError";
  }
}

/**
 * Attempts to load a specific FFmpeg build into a given FFmpeg instance.
 * Returns true on success, false on failure (non-abort errors).
 * Re-throws AbortError so cancellation always propagates immediately.
 */
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
    // Always propagate cancellation — never swallow an abort.
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      throw err;
    }
    return false;
  }
}

/**
 * Loads the best available FFmpeg build and returns a ready-to-use instance.
 *
 * Load order:
 *   1. Return the cached instance if already loaded.
 *   2. Try the best build detected by pickCoreBuild() (MT if SAB + hashes, else ST).
 *   3. If MT fails for any non-abort reason, automatically retry with ST.
 *   4. If ST also fails, throw FFmpegLoadError.
 *
 * The progress listener is scoped strictly to this function and removed
 * in `finally` so exportVideo's listener never sees double events.
 *
 * @param signal      AbortSignal — cancels network requests if user clicks Cancel.
 * @param onProgress  Optional callback (0–100) during WASM load.
 */
export async function loadFFmpeg(
  signal?: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    onProgress?.(100);
    return ffmpegInstance;
  }

  const ffmpeg = ffmpegInstance ?? new FFmpeg();
<<<<<<< HEAD
  ffmpegInstance = ffmpeg;
=======
>>>>>>> 23ca446 (fix:internal updates)

  // Progress listener is attached here and removed in `finally`.
  // exportVideo attaches its own separate listener for the encode phase.
  const handleProgress = ({ progress }: { progress: number }) => {
    onProgress?.(Math.round(progress * 100));
  };
  ffmpeg.on("progress", handleProgress);

  try {
    const preferredBuild = await pickCoreBuild();
    const loaded = await tryLoadBuild(ffmpeg, preferredBuild, signal);

    if (loaded) {
      loadedBuildIsMultiThread = preferredBuild.isMultiThread;
      if (process.env.NODE_ENV === "development") {
        console.info(
          `[FFmpeg] Loaded ${
            preferredBuild.isMultiThread ? "multi-thread (MT)" : "single-thread (ST)"
          } build`
        );
      }
      onProgress?.(100);
      return ffmpeg;
    }

    // MT load failed (non-abort) — warn and retry with ST.
    if (preferredBuild.isMultiThread) {
      console.warn(
        "[FFmpeg] Multi-thread build failed to load. Retrying with single-thread fallback."
      );

      const stBuild = {
        baseUrl: BASE_ST,
        coreFile: "ffmpeg-core.js",
        wasmFile: "ffmpeg-core.wasm",
        isMultiThread: false as const,
      };

      // Reuse the same FFmpeg instance — it hasn't been corrupted, the load
      // simply didn't succeed. A fresh load() call is safe.
      const stLoaded = await tryLoadBuild(ffmpeg, stBuild, signal);
      if (stLoaded) {
        loadedBuildIsMultiThread = false;
        if (process.env.NODE_ENV === "development") {
          console.info("[FFmpeg] Loaded single-thread (ST) build via fallback.");
        }
        onProgress?.(100);
        return ffmpeg;
      }
    }

    // Both builds failed.
    throw new FFmpegLoadError(
      "Failed to load the FFmpeg engine. Check your internet connection and try again."
    );
  } catch (err) {
    if (err instanceof FFmpegLoadError) throw err;

    // Cancellation — clean up so the next attempt starts fresh.
    if (ffmpegInstance === ffmpeg) {
      ffmpegInstance = null;
      loadedBuildIsMultiThread = null;
    }

    const wasCancelled =
      signal?.aborted || (err instanceof DOMException && err.name === "AbortError");

    if (wasCancelled) throw err; // propagate cancellation as-is

    throw new FFmpegLoadError(
      "Failed to load the FFmpeg engine. Check your internet connection and try again."
    );
  } finally {
    // Always remove the load-phase progress listener regardless of outcome.
    ffmpeg.off("progress", handleProgress);
  }
}

/**
 * Terminates the cached FFmpeg WASM worker and clears the singleton.
 * Called by cancelExport() in useVideoEditor.ts so that the next export
 * starts with a clean instance rather than a potentially corrupt one.
 */
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

export function buildAudioFilter(speed: number, normalizeAudio: boolean): string {
  const filters: string[] = [];

  // atempo only accepts values between 0.5 and 2.0 — chain multiple
  // instances for speeds outside that range (e.g. 0.25 needs two ×0.5).
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

  if (format === "webm") {
    args.push("-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(recipe.quality));
    if (shouldKeepAudio) args.push("-c:a", "libopus");
  } else if (format === "mkv") {
    args.push("-c:v", "libx264", "-crf", String(recipe.quality), "-preset", "medium");
    if (shouldKeepAudio) args.push("-c:a", "aac", "-b:a", "128k");
  } else {
    args.push(
      "-c:v",
      "libx264",
      "-crf",
      String(recipe.quality),
      "-preset",
      "medium",
      "-movflags",
      "+faststart"
    );
    if (shouldKeepAudio) args.push("-c:a", "aac", "-b:a", "128k");
  }

  args.push(outputName);
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

  // libx264 requires both dimensions to be divisible by 2.
  targetW = Math.round(targetW / 2) * 2;
  targetH = Math.round(targetH / 2) * 2;

  const ext = file.name.split(".").pop() ?? "mp4";
  const inputName = `input_${sessionId}.${ext}`;

  const getOutputConfig = (format: string) => {
    switch (format) {
      case "webm":
        return { filename: `output_${sessionId}.webm`, mimeType: "video/webm" };
      case "mkv":
        return { filename: `output_${sessionId}.mkv`, mimeType: "video/x-matroska" };
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

  // Scoped to the encode phase only — loadFFmpeg uses its own listener.
  const handleProgress = ({ progress }: { progress: number }) => {
    onProgress(Math.min(99, Math.round(progress * 100)));
  };

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file), { signal });

    const hasMusicTrack = !!(musicOptions?.file && recipe.keepAudio);
    const musicInputName = `music_input_${sessionId}.mp3`;
    if (hasMusicTrack) {
      await ffmpeg.writeFile(musicInputName, await fetchFile(musicOptions!.file!), {
        signal,
      });
      cleanupFiles.add(musicInputName);
    }

    const hasOverlay = !!(overlayOptions?.file);
    const overlayExt = overlayOptions?.file?.name.split(".").pop() ?? "png";
    const overlayInputName = `overlay_${sessionId}.${overlayExt}`;
    if (hasOverlay) {
      await ffmpeg.writeFile(overlayInputName, await fetchFile(overlayOptions!.file!), {
        signal,
      });
      cleanupFiles.add(overlayInputName);
    }

    ffmpeg.on("progress", handleProgress);

    // ── Two-pass GIF export ─────────────────────────────────────────────────
    if (recipe.format === "gif") {
      const vf = buildVideoFilter(recipe, targetW, targetH);
      const vfWithPalette = vf ? `${vf},palettegen` : "palettegen";
      const vfWithPaletteUse = vf
        ? `[0:v]${vf}[x];[x][1:v]paletteuse`
        : "[0:v][1:v]paletteuse";

      // Pass 1 — generate optimal colour palette for this clip
      const pass1Code = await ffmpeg.exec(
        ["-i", inputName, "-vf", vfWithPalette, "-y", paletteName],
        undefined,
        { signal }
      );
      if (pass1Code !== 0) throw new Error("GIF palette generation failed");

      // Pass 2 — render GIF using the generated palette
      const pass2Code = await ffmpeg.exec(
        ["-i", inputName, "-i", paletteName, "-lavfi", vfWithPaletteUse, "-y", outputName],
        undefined,
        { signal }
      );
      if (pass2Code !== 0) throw new Error("GIF export failed");

      const data = await ffmpeg.readFile(outputName, undefined, { signal });
      const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: "image/gif" });

      ffmpeg.off("progress", handleProgress);
      onProgress(100);
      return {
        blobUrl: URL.createObjectURL(blob),
        size: blob.size,
        width: targetW,
        height: targetH,
        format: "gif" as const,
      };
    }
    // ───────────────────────────────────────────────────────────────────────

    // Listen for FFmpeg log lines that indicate the input has no audio track.
    // We use this to automatically retry without requesting audio streams,
    // rather than crashing with a confusing error.
    let missingAudioDetected = false;
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
    ffmpeg.on("log", logListener);

    // Attempt 1 — standard export assuming audio exists
    let args = buildArguments(
      recipe,
      recipe.format,
      outputName,
      inputName,
      targetW,
      targetH,
      hasMusicTrack,
      musicInputName,
      musicOptions,
      hasOverlay,
      overlayInputName,
      overlayOptions,
      true
    );
    let exitCode = await ffmpeg.exec(args, undefined, { signal });

    // Attempt 2 — auto-recover if file had no audio track
    if (exitCode !== 0 && missingAudioDetected) {
      missingAudioDetected = false;
      args = buildArguments(
        recipe,
        recipe.format,
        outputName,
        inputName,
        targetW,
        targetH,
        hasMusicTrack,
        musicInputName,
        musicOptions,
        hasOverlay,
        overlayInputName,
        overlayOptions,
        false
      );
      exitCode = await ffmpeg.exec(args, undefined, { signal });
    }

    // Attempt 3 — switch to WebM if the chosen container has codec issues
    if (exitCode !== 0) {
      args = buildArguments(
        recipe,
        "webm",
        fallbackOutputName,
        inputName,
        targetW,
        targetH,
        hasMusicTrack,
        musicInputName,
        musicOptions,
        hasOverlay,
        overlayInputName,
        overlayOptions,
        !missingAudioDetected
      );
      const fallbackCode = await ffmpeg.exec(args, undefined, { signal });
      if (fallbackCode !== 0) throw new Error("Export failed");

      const data = await ffmpeg.readFile(fallbackOutputName, undefined, { signal });
      const blob = new Blob([new Uint8Array(data as Uint8Array)], {
        type: "video/webm",
      });

      ffmpeg.off("log", logListener);
      ffmpeg.off("progress", handleProgress);
      onProgress(100);
      return {
        blobUrl: URL.createObjectURL(blob),
        size: blob.size,
        width: targetW,
        height: targetH,
        format: "webm",
      };
    }

    const data = await ffmpeg.readFile(outputName, undefined, { signal });
    const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: mimeType });

    ffmpeg.off("log", logListener);
    ffmpeg.off("progress", handleProgress);
    onProgress(100);
    return {
      blobUrl: URL.createObjectURL(blob),
      size: blob.size,
      width: targetW,
      height: targetH,
      format: recipe.format as "mp4" | "webm" | "mkv",
    };
  } finally {
    // Guarantee listener removal even if an exception is thrown mid-export.
    ffmpeg.off("progress", handleProgress);
    // Always clean up temporary files from the WASM virtual filesystem
    // to avoid memory accumulation across multiple exports.
    for (const path of cleanupFiles) {
      try {
        await ffmpeg.deleteFile(path);
      } catch {
        // Ignore — file may not exist if export failed before it was written.
      }
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
