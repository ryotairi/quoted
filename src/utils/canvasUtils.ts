import { loadImage, Image } from "@napi-rs/canvas";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
} from "fs";
import path from "path";
import sharp from "sharp";
import { createLogger } from "./logger";

const log = createLogger("canvas");

const CACHE_DIR = "tmp/image_cache";
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function getCachePath(url: string, ext = "png"): string {
  const hash = createHash("md5").update(url).digest("hex");
  return path.join(CACHE_DIR, `${hash}.${ext}`);
}

// Negative cache: media that 404'd (e.g. custom emoji cleaned up by server retention).
// Avoids hammering the server with repeat requests for media that's gone for good.
const NEGATIVE_CACHE_TTL = 10 * 60 * 1000; // 10 min
const negativeCache = new Map<string, number>();
function isNegativelyCached(url: string): boolean {
  const t = negativeCache.get(url);
  if (t === undefined) return false;
  if (Date.now() - t > NEGATIVE_CACHE_TTL) {
    negativeCache.delete(url);
    return false;
  }
  return true;
}
function markFailed(url: string) {
  negativeCache.set(url, Date.now());
}

// Compact a media URL for logging: hide access tokens, keep server/mediaId.
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(
      /\/media\/(?:download|thumbnail)\/([^/]+)\/([^/?#]+)/,
    );
    if (m)
      return `${m[1]}/${m[2]}${u.pathname.includes("thumbnail") ? " (thumb)" : ""}`;
    return u.host + u.pathname.slice(0, 48);
  } catch {
    return url.slice(0, 60);
  }
}

export type ResolvedMedia = {
  buffer: Buffer;
  mime: string;
  ext: string;
  animated: boolean;
};

export async function downloadFile(
  url: string,
  label = "media",
  timeoutMs = 15000,
): Promise<ResolvedMedia | null> {
  const resolvedUrl = url;
  if (isNegativelyCached(resolvedUrl)) {
    log.debug(
      `media ${label} skipped (negative-cached): ${shortUrl(resolvedUrl)}`,
    );
    return null;
  }
  const started = Date.now();
  try {
    const headers: Record<string, string> = {
      "User-Agent":
        "QuotedMatrix/1.0 (+https://github.com/Vadim-Khristenko/quoted-matrix)",
      Accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    };
    // Add Bearer auth for Matrix homeserver media endpoints
    const isMatrix = resolvedUrl.includes("/_matrix/");
    if (isMatrix) {
      try {
        const { default: cfg } = await import("../services/config");
        const token = (cfg as any).matrix?.accessToken;
        if (token) headers["Authorization"] = `Bearer ${token}`;
      } catch {}
    }
    const res = await fetch(resolvedUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      // 404/410 = media gone for good → negative-cache it
      if (res.status === 404 || res.status === 410) markFailed(resolvedUrl);
      log.warn(`${label} ${shortUrl(resolvedUrl)} (${ms}ms)`, {
        status: res.status,
      });
      return null;
    }
    const contentType = res.headers.get("content-type") || "";
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    log.debug(
      `media ${label} ← ${res.status} ${(buffer.length / 1024).toFixed(1)}KB ${contentType} (${ms}ms) ${shortUrl(resolvedUrl)}`,
    );

    // Guess ext
    let ext = "";
    const lower = resolvedUrl.toLowerCase();
    if (contentType.includes("webm")) ext = "webm";
    else if (contentType.includes("mp4")) ext = "mp4";
    else if (contentType.includes("gif")) ext = "gif";
    else if (contentType.includes("webp")) ext = "webp";
    else if (contentType.includes("png")) ext = "png";
    else if (contentType.includes("jpeg") || contentType.includes("jpg"))
      ext = "jpg";
    else if (contentType.includes("svg")) ext = "svg";
    else if (contentType.includes("tgs") || lower.endsWith(".tgs")) ext = "tgs";
    else {
      if (lower.includes(".webm")) ext = "webm";
      else if (lower.includes(".mp4")) ext = "mp4";
      else if (lower.includes(".tgs")) ext = "tgs";
      else if (lower.includes(".gif")) ext = "gif";
      else if (lower.includes(".webp")) ext = "webp";
      else if (lower.includes(".png")) ext = "png";
      else if (lower.includes(".jpg") || lower.includes(".jpeg")) ext = "jpg";
      else if (lower.includes(".svg")) ext = "svg";
      else ext = "bin";
    }

    const animated =
      contentType.includes("webp") ||
      contentType.includes("gif") ||
      ["webm", "mp4", "gif", "tgs"].includes(ext) ||
      lower.includes("animated");

    return { buffer, mime: contentType, ext, animated };
  } catch (e) {
    const ms = Date.now() - started;
    const isTimeout = e instanceof Error && e.name === "TimeoutError";
    log.fail(
      `media ${label} ${isTimeout ? `TIMEOUT after ${ms}ms` : "ERROR " + String(e).slice(0, 80)} ${shortUrl(resolvedUrl)}`,
    );
    return null;
  }
}

export function normalizeFfmpegPath(raw: unknown): string {
  let p = typeof raw === "string" ? raw.trim() : "";
  if (!p) return "ffmpeg";
  // Strip Python-style raw-string prefix the user might paste: r"…" / R'…'
  p = p.replace(/^[rR](?=["'])/, "");
  // Strip one layer of surrounding quotes
  if (
    (p.startsWith('"') && p.endsWith('"')) ||
    (p.startsWith("'") && p.endsWith("'"))
  ) {
    p = p.slice(1, -1);
  }
  // Repair YAML double-quote escape corruption on Windows paths (\f→FF, \b→BS, \t→TAB …)
  // by mapping the resulting control chars back to "\<letter>". Best-effort safety net –
  // the correct fix is to use forward slashes or single quotes in config.yml.
  p = p
    .replace(/\f/g, "\\f")
    .replace(/\x08/g, "\\b")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\v/g, "\\v")
    .replace(/\0/g, "\\0");
  return p || "ffmpeg";
}

async function getFfmpegPath(): Promise<string> {
  try {
    const { default: cfg } = await import("../services/config");
    return normalizeFfmpegPath((cfg as any).render?.ffmpegPath);
  } catch {
    return "ffmpeg";
  }
}

async function tryExtractVideoFrame(
  inputPath: string,
  outputPath: string,
  frameNum = 0,
): Promise<boolean> {
  try {
    const { $ } = await import("bun");
    const ff = await getFfmpegPath();
    await $`${ff} -y -loglevel error -i ${inputPath} -vf select=eq(n\\,${frameNum}) -vframes 1 -an ${outputPath}`.quiet();
    return existsSync(outputPath);
  } catch (e) {
    log.debug("ffmpeg frame extract failed", e);
    return false;
  }
}

/**
 * Extract frames from an animated GIF/WebP using sharp – this PRESERVES ALPHA,
 * unlike ffmpeg which composites transparent frames onto a black background.
 * Returns [] if the source isn't a multi-page image (caller falls back to ffmpeg).
 */
export async function extractFramesSharp(
  inputBuffer: Buffer,
  outDir: string,
  maxFrames = 60,
): Promise<string[]> {
  try {
    const meta = await sharp(inputBuffer, { animated: true }).metadata();
    const pages = meta.pages ?? 1;
    if (pages <= 1) return []; // not animated → let caller handle as still
    mkdirSync(outDir, { recursive: true });
    // Sample frames evenly if there are more than maxFrames
    const step = pages > maxFrames ? pages / maxFrames : 1;
    const files: string[] = [];
    let outIdx = 0;
    for (let f = 0; f < pages; f += step) {
      const page = Math.floor(f);
      const png = await sharp(inputBuffer, { page }).png().toBuffer(); // single frame, alpha preserved
      const outPath = path.join(
        outDir,
        `frame_${String(outIdx).padStart(3, "0")}.png`,
      );
      writeFileSync(outPath, png);
      files.push(outPath);
      outIdx++;
      if (outIdx >= maxFrames) break;
    }
    log.info(
      `Extracted ${files.length}/${pages} frames via sharp (alpha preserved) from ${meta.format}`,
    );
    return files;
  } catch (e) {
    log.debug(
      "sharp frame extraction failed, will fall back to ffmpeg",
      String(e).slice(0, 120),
    );
    return [];
  }
}

export async function extractVideoFrames(
  inputPath: string,
  outDir: string,
  maxFrames = 60,
  fps = 20,
): Promise<string[]> {
  try {
    const { $ } = await import("bun");
    const ff = await getFfmpegPath();
    mkdirSync(outDir, { recursive: true });
    await $`${ff} -y -loglevel error -i ${inputPath} -vf fps=${fps} -vframes ${maxFrames} ${path.join(outDir, "frame_%03d.png")}`.quiet();
    const files = readdirSync(outDir)
      .filter((f) => f.startsWith("frame_") && f.endsWith(".png"))
      .sort()
      .map((f) => path.join(outDir, f));
    log.info(
      `Extracted ${files.length} frames via ffmpeg from ${path.basename(inputPath)}`,
    );
    return files;
  } catch (e) {
    log.warn("ffmpeg extract frames failed", e);
    return [];
  }
}

// Lottie (.tgs) vector animation – renderer not bundled, fall back to placeholder.
async function tryRenderTgs(
  buffer: Buffer,
  outputPath: string,
): Promise<boolean> {
  try {
    const { gunzipSync } = await import("zlib");
    let jsonStr: string;
    try {
      jsonStr = gunzipSync(buffer).toString("utf-8");
    } catch {
      jsonStr = buffer.toString("utf-8");
    }
    JSON.parse(jsonStr);
    log.debug(
      "lottie vector sticker detected, renderer unavailable – using placeholder",
    );
    return false;
  } catch (e) {
    log.warn("lottie render failed", e);
    return false;
  }
}

export async function loadCanvasImage(
  url: string,
  opts: { emoji?: boolean } = {},
): Promise<Image | null> {
  if (!url) return null;
  const logCtx = opts.emoji ? "emoji" : "image";

  // Matrix media (/_matrix/) needs an Authorization header, which loadImage() can't set,
  // so go straight to downloadFile(). Other URLs can try the fast direct-load path first.
  const isMatrixMedia = url.includes("/_matrix/");

  if (!isMatrixMedia) {
    try {
      return await loadImage(url);
    } catch {
      // fall through to manual download
    }
  }

  try {
    let buffer: Buffer | null = null;
    let ext = "";
    let mime = "";
    let animated = false;

    if (url.startsWith("http://") || url.startsWith("https://")) {
      let dl = await downloadFile(url, logCtx);
      // Fallback: Matrix thumbnail 404 → try the download endpoint instead
      if (!dl && url.includes("/_matrix/client/v1/media/thumbnail/")) {
        const fallbackUrl = url
          .replace(
            "/_matrix/client/v1/media/thumbnail/",
            "/_matrix/client/v1/media/download/",
          )
          .replace(/\?.*$/, "");
        log.debug(
          `Thumbnail 404, trying download URL for ${logCtx}`,
          fallbackUrl.slice(0, 100),
        );
        dl = await downloadFile(fallbackUrl, logCtx);
      }
      if (!dl) {
        log.fail(`could not fetch ${logCtx} ${shortUrl(url)}`);
        return null;
      }
      buffer = dl.buffer;
      ext = dl.ext;
      mime = dl.mime;
      animated = dl.animated;
    } else if (url.startsWith("file://")) {
      const fp = url.replace("file://", "");
      if (existsSync(fp)) {
        buffer = readFileSync(fp);
        ext = path.extname(fp).slice(1).toLowerCase();
        log.debug(`Loaded local file ${logCtx}`, fp);
      }
    } else {
      if (existsSync(url)) {
        buffer = readFileSync(url);
        ext = path.extname(url).slice(1).toLowerCase();
      }
    }

    if (!buffer) {
      try {
        return await loadImage(url);
      } catch (e) {
        log.warn(`Unable to load ${logCtx}`, url.slice(0, 100), String(e));
        return null;
      }
    }

    const cachePng = getCachePath(url, "png");
    if (!animated && existsSync(cachePng)) {
      try {
        return await loadImage(cachePng);
      } catch {}
    }

    // 1. Sharp conversion for still images
    if (
      ["webp", "gif", "avif", "png", "jpg", "jpeg", "tiff", "svg"].includes(ext)
    ) {
      try {
        const pngBuffer = await sharp(buffer, {
          animated: false,
          limitInputPixels: 8000 * 8000,
        })
          .png()
          .toBuffer();
        if (!animated) writeFileSync(cachePng, pngBuffer);
        const img = await loadImage(pngBuffer);
        log.debug(
          `Decoded ${logCtx} via sharp`,
          ext,
          `${img.width}x${img.height}`,
        );
        return img;
      } catch (e) {
        log.debug(`sharp conversion failed for ${logCtx}`, ext, String(e));
      }
    }

    // 2. Video / animated – extract first frame (also catch video by mime)
    if (
      ["webm", "mp4", "mov", "mkv", "gif", "webp"].includes(ext) ||
      mime.startsWith("video/")
    ) {
      const tmpIn = getCachePath(url, ext);
      const tmpOut = cachePng;
      writeFileSync(tmpIn, buffer);
      const ok = await tryExtractVideoFrame(tmpIn, tmpOut, 0);
      try {
        unlinkSync(tmpIn);
      } catch {}
      if (ok) {
        const img = await loadImage(tmpOut);
        log.info(
          `Extracted first video frame for ${logCtx}`,
          `${img.width}x${img.height}`,
        );
        return img;
      }
      try {
        const pngBuffer = await sharp(buffer, { pages: 1 }).png().toBuffer();
        if (!animated) writeFileSync(cachePng, pngBuffer);
        return await loadImage(pngBuffer);
      } catch {}
    }

    // 3. Lottie (.tgs) vector – no renderer bundled, use placeholder
    if (ext === "tgs" || (buffer[0] === 0x1f && buffer[1] === 0x8b)) {
      const rendered = await tryRenderTgs(buffer, cachePng);
      if (rendered && existsSync(cachePng)) {
        return await loadImage(cachePng);
      }
      log.debug("lottie sticker – using placeholder", shortUrl(url));
      return await generatePlaceholder("sticker");
    }

    // 4. Direct load
    try {
      return await loadImage(buffer);
    } catch {}

    // 5. Sharp final
    try {
      const pngBuffer = await sharp(buffer).png().toBuffer();
      if (!animated) writeFileSync(cachePng, pngBuffer);
      return await loadImage(pngBuffer);
    } catch (e) {
      // Expected for some formats during the fallback chain – not fatal, a later URL may work.
      log.debug(
        `could not decode ${logCtx} (${mime || ext || "unknown"}) ${shortUrl(url)}`,
      );
      return null;
    }
  } catch (e) {
    log.warn(
      `loadCanvasImage error ${logCtx}`,
      shortUrl(url),
      String(e).slice(0, 80),
    );
    return null;
  }
}

export type PlaceholderKind = "gif" | "video" | "sticker" | "image";

// Font Awesome 6 Free Solid glyphs (Private Use Area)
const PLACEHOLDER_META: Record<
  PlaceholderKind,
  { icon: string; label: string }
> = {
  gif: { icon: "", label: "GIF" }, // fa-film
  video: { icon: "", label: "VIDEO" }, // fa-video
  sticker: { icon: "", label: "STICKER" }, // fa-face-smile
  image: { icon: "", label: "IMAGE" }, // fa-image
};

const placeholderCache = new Map<string, Image | null>();

// A clean, theme-matching card shown when media can't be fetched or generated.
// Rendered at the real media aspect ratio (w×h) so it's never stretched.
export async function generatePlaceholder(
  kind: PlaceholderKind = "sticker",
  width = 256,
  height = 256,
): Promise<Image | null> {
  const W = Math.max(96, Math.round(width));
  const H = Math.max(96, Math.round(height));
  const key = `${kind}:${W}x${H}`;
  if (placeholderCache.has(key)) return placeholderCache.get(key)!;
  try {
    const { Canvas } = await import("@napi-rs/canvas");
    const { registerFonts, FONT_FAMILY_SANS, FONT_FAMILY_ICONS } =
      await import("./registerFonts");
    registerFonts();
    const canvas = new Canvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    const meta = PLACEHOLDER_META[kind];
    const m = Math.min(W, H); // scale glyph/text to the smaller side

    // Rounded dark card matching the bubble palette
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#2a2a3e");
    grad.addColorStop(1, "#1b1b29");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(4, 4, W - 8, H - 8, Math.round(m * 0.11));
    ctx.fill();

    // Dashed inner frame for a "missing media" feel
    ctx.strokeStyle = "rgba(165,180,252,0.35)";
    ctx.lineWidth = Math.max(1.5, m * 0.008);
    const inset = Math.round(m * 0.1);
    ctx.setLineDash([m * 0.03, m * 0.03]);
    ctx.beginPath();
    ctx.roundRect(inset, inset, W - inset * 2, H - inset * 2, Math.round(m * 0.07));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Icon (scaled to card)
    ctx.fillStyle = "#a5b4fc";
    ctx.font = `900 ${Math.round(m * 0.33)}px ${FONT_FAMILY_ICONS}`;
    ctx.fillText(meta.icon, W / 2, H / 2 - m * 0.07);
    // Label + sublabel
    ctx.fillStyle = "#e1e1e1";
    ctx.font = `bold ${Math.round(m * 0.09)}px ${FONT_FAMILY_SANS}`;
    ctx.fillText(meta.label, W / 2, H / 2 + m * 0.18);
    ctx.fillStyle = "#9a9ab0";
    ctx.font = `${Math.round(m * 0.05)}px ${FONT_FAMILY_SANS}`;
    ctx.fillText("unavailable", W / 2, H / 2 + m * 0.28);

    const img = await loadImage(canvas.toBuffer("image/png"));
    placeholderCache.set(key, img);
    return img;
  } catch (e) {
    log.warn("placeholder generation failed", String(e).slice(0, 80));
    placeholderCache.set(key, null);
    return null;
  }
}

export async function loadStickerImage(
  url: string,
  isAnimated = false,
): Promise<Image | null> {
  const img = await loadCanvasImage(url, { emoji: false });
  if (img) return img;
  if (isAnimated) return generatePlaceholder("sticker");
  return null;
}

export async function loadEmojiImage(
  url: string,
  altText?: string,
): Promise<Image | null> {
  const img = await loadCanvasImage(url, { emoji: true });
  if (img) return img;
  // Fallback: return null – caller will draw alt text via font (Noto Color Emoji)
  if (altText) {
    log.debug(
      "Emoji image failed, will fallback to text rendering",
      altText,
      url.slice(0, 80),
    );
  }
  return null;
}

// --- rest: wrapText, fillRoundRect, formatFileSize (unchanged, with logger) ---

export function wrapText(ctx: any, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let currentLine = "";
    const words = paragraph.split(" ");
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testLine =
        currentLine.length === 0 ? word : currentLine + " " + word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth) {
        if (currentLine.length === 0) {
          let currentWordPart = "";
          for (const char of word) {
            const testPart = currentWordPart + char;
            if (ctx.measureText(testPart).width > maxWidth) {
              lines.push(currentWordPart);
              currentWordPart = char;
            } else {
              currentWordPart = testPart;
            }
          }
          currentLine = currentWordPart;
        } else {
          lines.push(currentLine);
          currentLine = word;
        }
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines;
}

export function fillRoundRect(
  ctx: any,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number | { tl: number; tr: number; br: number; bl: number },
) {
  if (typeof radius === "number") {
    radius = { tl: radius, tr: radius, br: radius, bl: radius };
  }
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + width - radius.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
  ctx.lineTo(x + width, y + height - radius.br);
  ctx.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius.br,
    y + height,
  );
  ctx.lineTo(x + radius.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
  ctx.fill();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
