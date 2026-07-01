import client from "../services/matrix";
import config from "../services/config";
import createFileId from "./createFileId";
import { Canvas, Image, loadImage } from "@napi-rs/canvas";
import sharp from "sharp";
import {
  loadCanvasImage,
  loadEmojiImage,
  fillRoundRect,
  formatFileSize,
  extractVideoFrames,
  downloadFile,
  generatePlaceholder,
} from "./canvasUtils";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { sanitizeEventHtml } from "./sanitizeHtml";
import {
  parseHtml,
  layoutRichText,
  drawRichText,
  Token,
  ImageToken,
  MeasureOracle,
} from "./RichTextRenderer";
import {
  registerFonts,
  FONT_FAMILY_SANS,
  FONT_FAMILY_ICONS,
} from "./registerFonts";
import { createLogger } from "./logger";
import hljs from "highlight.js";

const log = createLogger("render");
registerFonts();

// Guard for ctx.drawImage – napi-rs/canvas throws a hard TypeError if handed
// anything that isn't a valid Image/Canvas (e.g. a failed decode or empty frame).
function isDrawable(v: any): boolean {
  return !!v && typeof v === "object" && typeof v.width === "number" && v.width > 0;
}

// Profile cache – avoid re-fetching the same user within a render batch
const profileCache = new Map<
  string,
  { displayname: string; avatarImage: Image | null }
>();
const PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 min
const profileCacheTime = new Map<string, number>();

async function fetchProfile(
  userId: string,
): Promise<{ displayname: string; avatarImage: Image | null }> {
  const now = Date.now();
  const cached = profileCache.get(userId);
  const cachedAt = profileCacheTime.get(userId) ?? 0;
  if (cached && now - cachedAt < PROFILE_CACHE_TTL) return cached;

  let displayname = userId;
  let avatarImage: Image | null = null;
  try {
    if (client && typeof client.getProfileInfo === "function") {
      const profile = await client.getProfileInfo(userId);
      displayname = profile.displayname || userId;
      if (profile.avatar_url) {
        // Fetch the ORIGINAL avatar and downscale it ourselves with a high-quality
        // Lanczos kernel + mild sharpen → much crisper than the server thumbnail,
        // and it survives lossy animated encoding far better.
        const avatarUrl = mxcToHttp(profile.avatar_url, false);
        const dl = await downloadFile(avatarUrl, "avatar");
        if (dl) {
          try {
            const buf = await sharp(dl.buffer, { limitInputPixels: 4096 * 4096 })
              .resize(144, 144, { fit: "cover", kernel: "lanczos3" })
              .sharpen()
              .png()
              .toBuffer();
            avatarImage = await loadImage(buf);
          } catch {
            avatarImage = await loadCanvasImage(
              mxcToHttp(profile.avatar_url, true, 256, 256),
            );
          }
        }
      }
    }
  } catch (e) {
    log.warn(`Profile fetch failed for ${userId}`, String(e));
  }
  const result = { displayname, avatarImage };
  profileCache.set(userId, result);
  profileCacheTime.set(userId, now);
  return result;
}

interface CreateImageOptions {
  hideReplies?: boolean;
}

function highlightCodeBlocks(html: string): string {
  return html.replace(
    /<pre><code(.*?)>([\s\S]*?)<\/code><\/pre>/gi,
    (match, attr, code) => {
      const unescaped = code
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
      const langMatch = attr.match(/class=["'].*?language-([^ "']+).*?["']/);
      const lang = langMatch ? langMatch[1] : undefined;
      let highlighted = "";
      try {
        if (lang && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(unescaped, { language: lang }).value;
        } else {
          highlighted = hljs.highlightAuto(unescaped).value;
        }
      } catch (e) {
        highlighted = code;
      }
      return `<pre><code${attr}>${highlighted}</code></pre>`;
    },
  );
}

function mxcToHttp(
  mxcUrl: string,
  thumbnail = true,
  width = 800,
  height = 800,
): string {
  if (!mxcUrl?.startsWith("mxc://")) return mxcUrl;
  const parts = mxcUrl.replace("mxc://", "").split("/");
  const serverName = parts[0];
  // Strip URL fragments (#...) from mediaId – some clients append hints like #auto
  const mediaId = parts.slice(1).join("/").split("#")[0];
  // NOTE: auth is provided via Authorization: Bearer header in downloadFile, NOT via query param
  // (query param access_token is deprecated in Matrix spec v1.7 and rejected by modern servers)
  if (thumbnail) {
    return `${config.matrix.homeserverUrl}/_matrix/client/v1/media/thumbnail/${serverName}/${mediaId}?width=${width}&height=${height}&method=scale`;
  }
  return `${config.matrix.homeserverUrl}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
}

type FileAttachment = {
  name: string;
  size: number;
  mime: string;
  url?: string;
  icon: string;
};

type ParsedEvent = any & {
  parsed: {
    displayname: string;
    avatarImage: Image | null;
    tokens: Token[];
    reply: any;
    attachedImage: Image | null;
    attachedImageSize: { width: number; height: number };
    fileAttachment: FileAttachment | null;
    isSticker: boolean;
    animatedMedia?: {
      url: string;
      mime: string;
      width: number;
      height: number;
    } | null;
  };
  layout?: any;
};

export default async function createImage(
  events: any[],
  options: CreateImageOptions = {},
): Promise<string> {
  const renderCfg = config.render;
  const t0 = Date.now();
  log.info(
    `createImage start – ${events.length} events, animated=${renderCfg.animatedStickers}, transparentBg=${renderCfg.transparentBackground}`,
  );

  const baseFileId = createFileId(events);
  const outPng = `tmp/${baseFileId}.png`;
  const animFormat = renderCfg.animatedFormat || "webp";
  const outAnim = `tmp/${baseFileId}.${animFormat}`;
  // Static PNG keeps alpha; the animated MP4 path disables this (MP4 has no alpha).
  let transparentBg = renderCfg.transparentBackground;

  const PADDING = 12;
  const AVATAR_SIZE = 36;
  const AVATAR_GAP = 10;
  const BUBBLE_PAD_X = 12;
  const BUBBLE_PAD_Y = 8;
  const TEXT_MAX_WIDTH = 420;
  const LINE_HEIGHT = 20;
  const IMAGE_MAX = 320; // display cap for inline (non-sticker) images

  const parsedEvents: ParsedEvent[] = [];

  // ---------- Pre-flight ----------
  for (let ei = 0; ei < events.length; ei++) {
    const event = events[ei];
    const isMessage = event.type === "m.room.message";
    const isStickerEvent = event.type === "m.sticker";
    if (!isMessage && !isStickerEvent) {
      log.debug(`skip event ${ei} type=${event.type}`);
      continue;
    }
    // Skip hidden/redacted (deleted) events unless explicitly enabled. A redacted
    // event has redacted_because in unsigned and/or an emptied content object.
    const isHidden =
      !!event.unsigned?.redacted_because ||
      !event.content ||
      Object.keys(event.content).length === 0;
    if (isHidden && !renderCfg.showHiddenMessages) {
      log.debug(`skip hidden/redacted event ${ei}`);
      continue;
    }
    log.debug(`Parsing event ${ei} sender=${event.sender} type=${event.type}`);

    let displayname = event.sender;
    let avatarImage: Image | null = null;
    let reply = null;
    let attachedImage: Image | null = null;
    let attachedImageSize = { width: 0, height: 0 };
    let fileAttachment: FileAttachment | null = null;
    let tokens: Token[] = [];
    let isSticker = false;
    let animatedMedia: ParsedEvent["parsed"]["animatedMedia"] = null;

    // Profile (cached)
    const prof = await fetchProfile(event.sender);
    displayname = prof.displayname;
    avatarImage = prof.avatarImage;
    log.debug(
      `Profile for ${event.sender}: name=${displayname} avatar=${!!avatarImage}`,
    );

    // Reply
    const replyToId =
      event.content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    if (!options.hideReplies && typeof replyToId === "string" && client) {
      try {
        const replyEvent = await client.fetchRoomEvent(
          event.room_id,
          replyToId,
        );
        const repProf = await fetchProfile(replyEvent.sender);
        let replyName = repProf.displayname;
        let repHtml = replyEvent.content?.body || "Unsupported";
        if (
          replyEvent.content?.format === "org.matrix.custom.html" &&
          replyEvent.content?.formatted_body
        ) {
          repHtml = highlightCodeBlocks(
            sanitizeEventHtml(replyEvent.content.formatted_body),
          );
        } else if (
          ["m.image", "m.sticker", "m.video"].includes(
            replyEvent.content?.msgtype,
          ) ||
          replyEvent.type === "m.sticker"
        ) {
          repHtml = "🖼️ Sticker / Image";
        } else if (replyEvent.content?.msgtype === "m.file") {
          repHtml = `📄 ${replyEvent.content?.body || "File"}`;
        } else {
          repHtml = repHtml
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br>");
        }
        reply = {
          displayname: replyName,
          tokens: parseHtml(repHtml, renderCfg.emojiSize),
        };
      } catch (e) {
        log.warn("Reply load failed", replyToId, String(e));
        reply = {
          displayname: "Unknown",
          tokens: [
            {
              type: "text",
              text: "Failed to load reply",
              style: {
                bold: false,
                italic: false,
                code: false,
                pre: false,
                strike: false,
                underline: false,
                blockquote: false,
                spoiler: false,
                size: 14,
                color: null,
                codeLang: null,
              },
            },
          ],
        };
      }
    }

    const msgtype =
      event.content?.msgtype || (isStickerEvent ? "m.sticker" : "m.text");
    const contentUrl = event.content?.url;
    const info = event.content?.info || {};

    // Media: image / sticker / video
    if (
      (contentUrl && ["m.image", "m.sticker", "m.video"].includes(msgtype)) ||
      isStickerEvent
    ) {
      isSticker = msgtype === "m.sticker" || isStickerEvent;
      const mime: string = info.mimetype || "";
      const isVideo = msgtype === "m.video";
      // Detect animation by mime, loop flag, or a .gif/.webm/.mp4 filename in the body.
      const bodyName = String(event.content?.body || "").toLowerCase();
      const isAnimated =
        /video|gif|webp.*animated|tgs/.test(mime) ||
        event.content?.info?.["fi.mau.loop"] === true ||
        /\.(gif|webm|mp4|apng)$/i.test(bodyName);
      log.info(
        `Media attachment found: type=${msgtype} mime=${mime} animated=${isAnimated} url=${String(contentUrl).slice(0, 60)}`,
      );

      // Build download URL list – for video prefer thumbnail_url (avoids downloading full video)
      const urlsToTry: string[] = [];
      if (contentUrl.startsWith("mxc://")) {
        const thumbMxc = info.thumbnail_url as string | undefined;
        if (isVideo) {
          // Video (incl. Matrix GIFs, which are m.video/mp4) can't be drawn directly.
          // Prefer an explicit poster (thumbnail_url), then the original – which
          // loadCanvasImage extracts a frame from via ffmpeg. Server thumbnails of
          // video reliably 400, so we don't bother with them.
          if (thumbMxc?.startsWith("mxc://"))
            urlsToTry.push(mxcToHttp(thumbMxc, false));
          urlsToTry.push(mxcToHttp(contentUrl, false));
        } else {
          // CRITICAL: load the ORIGINAL via download endpoint. Synapse's thumbnailer
          // flattens alpha → black background (verified). We resize client-side anyway.
          urlsToTry.push(mxcToHttp(contentUrl, false));
          // Thumbnail only as a last-ditch fallback (may have black bg, but better than nothing).
          urlsToTry.push(
            mxcToHttp(
              contentUrl,
              true,
              renderCfg.stickerMaxSize,
              renderCfg.stickerMaxSize,
            ),
          );
        }
      } else {
        urlsToTry.push(contentUrl);
      }

      let loaded = false;
      for (const u of urlsToTry) {
        attachedImage = await loadCanvasImage(u);
        if (attachedImage) {
          log.debug(
            `Image loaded from ${u.slice(0, 60)} – ${attachedImage.width}x${attachedImage.height}`,
          );
          loaded = true;
          break;
        }
      }
      // Couldn't fetch the media – always substitute a placeholder card so the quote
      // still renders fully with a clear "unavailable" marker. The card is generated
      // at the media's real aspect ratio (from info.w/h) so it isn't stretched.
      if (!loaded) {
        const isGif = /gif/.test(mime) || /\.gif$/i.test(bodyName);
        const kind: "gif" | "video" | "sticker" | "image" = isGif
          ? "gif"
          : isVideo
            ? "video"
            : isSticker
              ? "sticker"
              : "image";
        const aw = info.w || 256;
        const ah = info.h || 256;
        const pScale = 256 / Math.max(aw, ah);
        attachedImage = await generatePlaceholder(
          kind,
          aw * pScale,
          ah * pScale,
        );
        log.fail(
          `${kind} media unavailable, substituting placeholder – ${contentUrl}`,
        );
      }

      // animated media tracking
      if (isAnimated && renderCfg.animatedStickers) {
        animatedMedia = {
          url: contentUrl.startsWith("mxc://")
            ? mxcToHttp(contentUrl, false)
            : contentUrl,
          mime,
          width: info.w || attachedImage?.width || 512,
          height: info.h || attachedImage?.height || 512,
        };
        log.info(
          `Animated media registered for event ${ei}: ${mime} ${animatedMedia.width}x${animatedMedia.height}`,
        );
      }

      if (attachedImage) {
        // Display cap: stickers honour render.stickerMaxSize; plain images cap at IMAGE_MAX.
        const MAX = isSticker ? renderCfg.stickerMaxSize : IMAGE_MAX;
        let w = info.w || attachedImage.width;
        let h = info.h || attachedImage.height;
        // Scale down to fit the cap, preserving aspect ratio.
        if (w > MAX || h > MAX) {
          const scale = MAX / Math.max(w, h);
          w *= scale;
          h *= scale;
        }
        // Upscale tiny stickers to a readable minimum (bounded by the cap).
        if (isSticker) {
          const minSize = Math.min(160, MAX);
          if (w < minSize && h < minSize) {
            const scale = minSize / Math.max(w, h);
            w *= scale;
            h *= scale;
          }
        }
        // Round UP and keep the original aspect ratio (no forced 1:1).
        attachedImageSize = { width: Math.ceil(w), height: Math.ceil(h) };
      }

      // Caption
      let bodyText = event.content?.body || "";
      const isRawFilename =
        /^[\w\-_ .()]+\.(png|jpg|jpeg|gif|webp|webm|mp4|tgs)$/i.test(
          bodyText.trim(),
        );
      if (!isRawFilename && bodyText.trim() !== "" && !isSticker) {
        let htmlBody = bodyText;
        if (
          event.content.format === "org.matrix.custom.html" &&
          event.content.formatted_body
        ) {
          htmlBody = highlightCodeBlocks(
            sanitizeEventHtml(event.content.formatted_body),
          );
        } else {
          htmlBody = htmlBody
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br>");
        }
        tokens = parseHtml(htmlBody, renderCfg.emojiSize);
      }
    }
    // File / audio
    else if (contentUrl && ["m.file", "m.audio"].includes(msgtype)) {
      const filename = event.content?.body || "file.bin";
      const fileInfo = event.content?.info || {};
      const size = fileInfo.size || 0;
      const mime = fileInfo.mimetype || "application/octet-stream";
      // Font Awesome 6 Free Solid icons (Unicode Private Use Area)
      // fa-file: \uf15b, fa-file-pdf: \uf1c1, fa-file-audio: \uf1c7, fa-file-video: \uf1c8
      // fa-file-image: \uf1c5, fa-file-archive: \uf1c6, fa-file-word: \uf1c2, fa-file-excel: \uf1c3
      // fa-file-code: \uf1c9, fa-file-alt: \uf15c
      let icon = "\uf15b"; // fa-file
      if (mime.startsWith("audio/"))
        icon = "\uf1c7"; // fa-file-audio
      else if (mime.startsWith("video/"))
        icon = "\uf1c8"; // fa-file-video
      else if (mime.startsWith("image/"))
        icon = "\uf1c5"; // fa-file-image
      else if (mime.includes("pdf"))
        icon = "\uf1c1"; // fa-file-pdf
      else if (
        mime.includes("zip") ||
        mime.includes("archive") ||
        /\.(zip|rar|7z|tar|gz|bz2|xz)$/i.test(filename)
      )
        icon = "\uf1c6"; // fa-file-archive
      else if (/\.(doc|docx|odt|rtf)$/i.test(filename))
        icon = "\uf1c2"; // fa-file-word
      else if (/\.(xls|xlsx|ods|csv)$/i.test(filename))
        icon = "\uf1c3"; // fa-file-excel
      else if (/\.(ppt|pptx|odp)$/i.test(filename))
        icon = "\uf1c4"; // fa-file-powerpoint
      else if (
        /\.(js|ts|py|java|c|cpp|rs|go|sh|json|xml|html|css|php)$/i.test(
          filename,
        )
      )
        icon = "\uf1c9"; // fa-file-code
      else if (/\.(txt|md|log)$/i.test(filename)) icon = "\uf15c"; // fa-file-alt
      fileAttachment = { name: filename, size, mime, url: contentUrl, icon };
      log.info(`File attachment: ${filename} ${formatFileSize(size)} ${mime}`);
      if (
        event.content.format === "org.matrix.custom.html" &&
        event.content.formatted_body
      ) {
        tokens = parseHtml(
          highlightCodeBlocks(sanitizeEventHtml(event.content.formatted_body)),
          renderCfg.emojiSize,
        );
      }
    } else {
      // Text
      let htmlBody = event.content?.body || "";
      if (
        event.content.format === "org.matrix.custom.html" &&
        event.content.formatted_body
      ) {
        htmlBody = highlightCodeBlocks(
          sanitizeEventHtml(event.content.formatted_body),
        );
      } else {
        htmlBody = htmlBody
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
      }
      tokens = parseHtml(htmlBody, renderCfg.emojiSize);
      log.debug(
        `Text tokens: ${tokens.length} tokens, ${tokens.filter((t) => t.type === "image").length} inline images`,
      );
    }

    // Preload inline emoji – improved with loadEmojiImage + alt fallback
    for (const token of tokens) {
      if (token.type === "image") {
        const imgToken = token as ImageToken;
        try {
          const { loadEmojiImage } = await import("./canvasUtils");
          imgToken.imageObj =
            (await loadEmojiImage(imgToken.src, imgToken.alt)) || undefined;
          if (!imgToken.imageObj && imgToken.alt) {
            log.debug(
              `Emoji image failed, will fallback to text rendering: alt="${imgToken.alt}" src=${imgToken.src.slice(0, 60)}`,
            );
          }
        } catch (e) {
          log.warn("Emoji load error", imgToken.src, String(e));
        }
      }
    }
    if (reply) {
      for (const token of reply.tokens) {
        if (token.type === "image") {
          const imgToken = token as ImageToken;
          try {
            const { loadEmojiImage } = await import("./canvasUtils");
            imgToken.imageObj =
              (await loadEmojiImage(imgToken.src, imgToken.alt)) || undefined;
          } catch {}
        }
      }
    }

    parsedEvents.push({
      ...event,
      parsed: {
        displayname,
        avatarImage,
        tokens,
        reply,
        attachedImage,
        attachedImageSize,
        fileAttachment,
        isSticker,
        animatedMedia,
      },
    });
  }

  if (parsedEvents.length === 0) {
    throw new Error("No parseable events");
  }

  // ---------- Layout ----------
  const measureCanvas = new Canvas(1, 1);
  const measureCtx = measureCanvas.getContext("2d");
  const oracle = new MeasureOracle(measureCtx);

  let totalHeight = PADDING;
  let totalWidth = 0;
  const measureName = (text: string) =>
    oracle.measure(text, `bold 14px ${FONT_FAMILY_SANS}`);

  for (const event of parsedEvents) {
    const nameWidth = measureName(event.parsed.displayname);
    let replyLines: any[] = [],
      replyWidth = 0,
      replyHeight = 0;
    if (event.parsed.reply) {
      const prefixToken: Token = {
        type: "text",
        text: event.parsed.reply.displayname + ": ",
        style: {
          bold: true,
          italic: false,
          code: false,
          pre: false,
          strike: false,
          underline: false,
          blockquote: false,
          spoiler: false,
          size: 13,
          color: null,
          codeLang: null,
        },
      };
      const replyTokens = [prefixToken, ...event.parsed.reply.tokens];
      replyLines = layoutRichText(oracle, replyTokens, TEXT_MAX_WIDTH - 16);
      if (replyLines.length > 2) {
        replyLines = [replyLines[0], replyLines[1]];
        const ellipsisW = oracle.measure("...", `14px ${FONT_FAMILY_SANS}`);
        replyLines[1].items.push({
          type: "text",
          text: "...",
          style: {
            bold: false,
            italic: false,
            code: false,
            pre: false,
            strike: false,
            underline: false,
            blockquote: false,
            spoiler: false,
            size: 14,
            color: null,
            codeLang: null,
          },
          x: replyLines[1].width,
          w: ellipsisW,
        });
        replyLines[1].width += ellipsisW;
      }
      for (const line of replyLines) {
        replyHeight += line.height;
        const w = line.width + 16;
        if (w > replyWidth) replyWidth = w;
      }
      if (replyLines.length > 0) replyHeight += 8;
    }
    const lines = layoutRichText(oracle, event.parsed.tokens, TEXT_MAX_WIDTH);
    let maxLineWidth = 0,
      textHeight = 0;
    for (const line of lines) {
      if (line.width > maxLineWidth) maxLineWidth = line.width;
      textHeight += line.height;
    }
    const imgWidth = event.parsed.attachedImageSize.width;
    const imgHeight = event.parsed.attachedImageSize.height;
    let fileCardWidth = 0,
      fileCardHeight = 0;
    if (event.parsed.fileAttachment) {
      const fa = event.parsed.fileAttachment;
      fileCardWidth = 280;
      fileCardHeight = 62;
      const nameW = oracle.measure(fa.name, `bold 13px ${FONT_FAMILY_SANS}`);
      fileCardWidth = Math.max(
        fileCardWidth,
        Math.min(nameW + 64, TEXT_MAX_WIDTH),
      );
    }
    const bubbleWidth =
      Math.max(nameWidth, maxLineWidth, replyWidth, imgWidth, fileCardWidth) +
      BUBBLE_PAD_X * 2;
    let innerHeight = LINE_HEIGHT;
    if (replyHeight > 0) innerHeight += replyHeight + 4;
    if (lines.length > 0 && maxLineWidth > 0) innerHeight += textHeight;
    if (imgHeight > 0)
      innerHeight += imgHeight + (textHeight > 0 || replyHeight > 0 ? 8 : 0);
    if (fileCardHeight > 0)
      innerHeight +=
        fileCardHeight + (textHeight > 0 || replyHeight > 0 ? 8 : 0);
    const bubbleHeight = BUBBLE_PAD_Y * 2 + innerHeight;
    const rowHeight = Math.max(AVATAR_SIZE, bubbleHeight);
    const rowWidth = PADDING + AVATAR_SIZE + AVATAR_GAP + bubbleWidth + PADDING;
    event.layout = {
      lines,
      replyLines,
      replyHeight,
      bubbleWidth,
      bubbleHeight,
      rowHeight,
      maxLineWidth,
      fileCardWidth,
      fileCardHeight,
    };
    totalHeight += rowHeight + 8;
    if (rowWidth > totalWidth) totalWidth = rowWidth;
  }
  totalHeight = totalHeight - 8 + PADDING;
  if (totalWidth < 240) totalWidth = 240;
  // Round canvas dimensions UP to whole pixels (avoids fractional sizes like 400.42…).
  totalWidth = Math.ceil(totalWidth);
  totalHeight = Math.ceil(totalHeight);
  log.info(
    `Layout complete: ${totalWidth}x${totalHeight}, ${parsedEvents.length} messages`,
  );

  // Check for animated media
  const animatedEvents = parsedEvents.filter((e) => e.parsed.animatedMedia);
  const doAnimated = renderCfg.animatedStickers && animatedEvents.length > 0;
  if (animatedEvents.length > 0) {
    log.info(
      `Animated media detected in ${animatedEvents.length} event(s), animatedStickers config=${renderCfg.animatedStickers} → animated output = ${doAnimated}`,
    );
  }

  // ---------- Paint helper ----------
  const paintFrame = (
    ctx: any,
    stickerFrameOverride?: Map<ParsedEvent, Image>,
  ) => {
    // High-quality resampling so avatars / images stay crisp when downscaled.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // background. MP4 has no alpha channel, so a "transparent" quote would flatten to
    // an ugly white/black box – force the solid theme background for mp4 instead.
    if (!transparentBg) {
      ctx.fillStyle = "#0f0f1a";
      ctx.fillRect(0, 0, totalWidth, totalHeight);
    } else {
      ctx.clearRect(0, 0, totalWidth, totalHeight);
    }
    let currentY = PADDING;
    for (const event of parsedEvents) {
      const {
        lines,
        replyLines,
        replyHeight,
        bubbleWidth,
        bubbleHeight,
        maxLineWidth,
        fileCardHeight,
      } = event.layout;
      const startX = PADDING;
      // Avatar
      if (isDrawable(event.parsed.avatarImage)) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(
          startX + AVATAR_SIZE / 2,
          currentY + AVATAR_SIZE / 2,
          AVATAR_SIZE / 2,
          0,
          Math.PI * 2,
        );
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(
          event.parsed.avatarImage,
          startX,
          currentY,
          AVATAR_SIZE,
          AVATAR_SIZE,
        );
        ctx.restore();
      } else {
        let hash = 0;
        for (let i = 0; i < event.sender.length; i++)
          hash = event.sender.charCodeAt(i) + ((hash << 5) - hash);
        const hue = Math.abs(hash) % 360;
        ctx.fillStyle = `hsl(${hue},60%,45%)`;
        ctx.beginPath();
        ctx.arc(
          startX + AVATAR_SIZE / 2,
          currentY + AVATAR_SIZE / 2,
          AVATAR_SIZE / 2,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = `bold 16px ${FONT_FAMILY_SANS}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(
          (event.parsed.displayname?.[0] || "?").toUpperCase(),
          startX + AVATAR_SIZE / 2,
          currentY + AVATAR_SIZE / 2 + 1,
        );
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
      const bubbleX = startX + AVATAR_SIZE + AVATAR_GAP;
      const isPureSticker =
        event.parsed.isSticker &&
        lines.length === 0 &&
        !event.parsed.fileAttachment;
      if (!isPureSticker) {
        ctx.fillStyle = renderCfg.transparentBubbles
          ? "rgba(30,30,46,0.85)"
          : "#1e1e2e";
        fillRoundRect(ctx, bubbleX, currentY, bubbleWidth, bubbleHeight, {
          tl: 4,
          tr: 12,
          bl: 12,
          br: 12,
        });
      }
      let contentTop = currentY + BUBBLE_PAD_Y;
      if (!isPureSticker) {
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold 14px ${FONT_FAMILY_SANS}`;
        ctx.fillText(
          event.parsed.displayname,
          bubbleX + BUBBLE_PAD_X,
          contentTop + 14,
        );
        contentTop += LINE_HEIGHT;
      }
      if (event.parsed.reply && replyLines.length > 0) {
        const repX = bubbleX + BUBBLE_PAD_X;
        ctx.fillStyle = "#4a4a59";
        ctx.beginPath();
        ctx.roundRect(repX, contentTop, 3, replyHeight - 8, 2);
        ctx.fill();
        contentTop = drawRichText(
          ctx,
          replyLines,
          repX + 10,
          contentTop,
          bubbleWidth - BUBBLE_PAD_X * 2 - 10,
          "#aaaaaa",
        );
        contentTop += 4;
      }
      if (lines.length > 0 && maxLineWidth > 0) {
        contentTop = drawRichText(
          ctx,
          lines,
          bubbleX + BUBBLE_PAD_X,
          contentTop,
          bubbleWidth - BUBBLE_PAD_X * 2,
          "#e1e1e1",
        );
      }
      if (event.parsed.fileAttachment) {
        if (contentTop > currentY + BUBBLE_PAD_Y + LINE_HEIGHT) contentTop += 8;
        const fa = event.parsed.fileAttachment;
        const cardX = bubbleX + BUBBLE_PAD_X;
        const cardW = Math.max(260, bubbleWidth - BUBBLE_PAD_X * 2);
        const cardH = 56;
        ctx.fillStyle = renderCfg.transparentBubbles
          ? "rgba(42,42,62,0.9)"
          : "#2a2a3e";
        ctx.beginPath();
        ctx.roundRect(cardX, contentTop, cardW, cardH, 10);
        ctx.fill();
        ctx.fillStyle = "#3b3b5a";
        ctx.beginPath();
        ctx.arc(cardX + 28, contentTop + 28, 18, 0, Math.PI * 2);
        ctx.fill();
        // File icon – Font Awesome 6 Free Solid (weight 900)
        ctx.fillStyle = "#a5b4fc";
        ctx.font = `900 16px ${FONT_FAMILY_ICONS}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(fa.icon, cardX + 28, contentTop + 28);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "#e1e1e1";
        ctx.font = `bold 13px ${FONT_FAMILY_SANS}`;
        let name = fa.name;
        let nameWidth = ctx.measureText(name).width;
        const maxNameWidth = cardW - 60 - 8;
        while (nameWidth > maxNameWidth && name.length > 5) {
          name = name.slice(0, -4) + "…";
          nameWidth = ctx.measureText(name).width;
        }
        ctx.fillText(name, cardX + 52, contentTop + 24);
        ctx.fillStyle = "#9a9ab0";
        ctx.font = `12px ${FONT_FAMILY_SANS}`;
        ctx.fillText(
          `${formatFileSize(fa.size)} • ${fa.mime.split(";")[0]}`,
          cardX + 52,
          contentTop + 42,
        );
        contentTop += cardH;
      }
      // Image / Sticker
      let attachedImg = event.parsed.attachedImage;
      if (stickerFrameOverride && stickerFrameOverride.has(event)) {
        attachedImg = stickerFrameOverride.get(event)!;
      }
      if (isDrawable(attachedImg)) {
        if (
          contentTop >
          currentY + BUBBLE_PAD_Y + (isPureSticker ? 0 : LINE_HEIGHT)
        )
          contentTop += 8;
        const { width: w, height: h } = event.parsed.attachedImageSize;
        ctx.save();
        if (!event.parsed.isSticker) {
          ctx.beginPath();
          ctx.roundRect(bubbleX + BUBBLE_PAD_X, contentTop, w, h, 8);
          ctx.clip();
        }
        ctx.drawImage(attachedImg, bubbleX + BUBBLE_PAD_X, contentTop, w, h);
        ctx.restore();
      }
      currentY += event.layout.rowHeight + 8;
    }
  };

  // ---------- Static render ----------
  if (!doAnimated) {
    const canvas = new Canvas(totalWidth, totalHeight);
    const ctx = canvas.getContext("2d");
    paintFrame(ctx);
    const buffer = await canvas.toBuffer("image/png");
    writeFileSync(outPng, buffer);
    log.info(
      `Static PNG rendered in ${Date.now() - t0}ms → ${outPng} ${(buffer.length / 1024).toFixed(1)}KB`,
    );
    return outPng;
  }

  // ---------- Animated render ----------
  log.info("Starting animated sticker render pipeline");
  try {
    // Find first animated event (simplify – support 1 animated sticker per quote for now)
    const animEvent = animatedEvents[0];
    if (!animEvent || !animEvent.parsed.animatedMedia)
      throw new Error("No animated media found");
    const media = animEvent.parsed.animatedMedia;
    log.info(
      `Animated source: ${media.mime} ${media.width}x${media.height} url=${media.url.slice(0, 80)}`,
    );

    // Download animated source via downloadFile (Bearer auth + 30s timeout for larger media)
    const isVideoSrc =
      media.mime.includes("webm") || media.mime.includes("mp4");
    const ext = media.mime.includes("webm")
      ? "webm"
      : media.mime.includes("mp4")
        ? "mp4"
        : media.mime.includes("webp")
          ? "webp"
          : "gif";
    const tmpAnimPath = `tmp/anim_src_${baseFileId}.${ext}`;
    const dlResult = await downloadFile(media.url, "animated-media", 30000);
    if (!dlResult)
      throw new Error(
        `Failed to download animated media from ${media.url.slice(0, 60)}`,
      );
    writeFileSync(tmpAnimPath, dlResult.buffer);
    log.debug(
      `Saved animated source to ${tmpAnimPath} ${(dlResult.buffer.length / 1024).toFixed(1)}KB`,
    );

    // Extract frames
    const framesDir = `tmp/anim_frames_${baseFileId}`;
    if (existsSync(framesDir))
      rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    const { extractVideoFrames, extractFramesSharp } =
      await import("./canvasUtils");
    let frameFiles: string[] = [];
    // For GIF/WebP, sharp preserves alpha (ffmpeg flattens transparency → black).
    if (!isVideoSrc) {
      frameFiles = await extractFramesSharp(
        dlResult.buffer,
        framesDir,
        renderCfg.maxFrames,
      );
    }
    // Fall back to ffmpeg for video, or if sharp couldn't extract frames.
    if (frameFiles.length === 0) {
      frameFiles = await extractVideoFrames(
        tmpAnimPath,
        framesDir,
        renderCfg.maxFrames,
        renderCfg.fps,
      );
    }
    if (frameFiles.length === 0) throw new Error("No frames extracted");
    log.info(
      `Extracted ${frameFiles.length} frames (alpha-safe=${!isVideoSrc})`,
    );

    // MP4 has no alpha – render frames on the solid theme background so transparent
    // stickers don't flatten to white/black.
    if (animFormat === "mp4") transparentBg = false;

    // Render composite frames
    const compositeDir = `tmp/anim_composite_${baseFileId}`;
    if (existsSync(compositeDir))
      rmSync(compositeDir, { recursive: true, force: true });
    mkdirSync(compositeDir, { recursive: true });

    const { loadImage } = await import("@napi-rs/canvas");
    for (let i = 0; i < frameFiles.length; i++) {
      const stickerFrame = await loadImage(frameFiles[i]);
      const canvas = new Canvas(totalWidth, totalHeight);
      const ctx = canvas.getContext("2d");
      const override = new Map();
      override.set(animEvent, stickerFrame);
      paintFrame(ctx, override);
      const outFrame = path.join(
        compositeDir,
        `frame_${String(i).padStart(3, "0")}.png`,
      );
      writeFileSync(outFrame, await canvas.toBuffer("image/png"));
    }
    log.info(`Composited ${frameFiles.length} frames`);

    // Encode the chosen animated format. Some bridges can't display animated WebP,
    // so gif (transparency-aware) and mp4 (universally supported, no alpha) are options.
    const { $ } = await import("bun");
    const { normalizeFfmpegPath } = await import("./canvasUtils");
    const fps = renderCfg.fps;
    const ff = normalizeFfmpegPath(renderCfg.ffmpegPath);
    const frames = `${compositeDir}/frame_%03d.png`;
    // Filter strings MUST be passed as interpolated variables, not inline – bun's $
    // would otherwise try to parse ';' '(' '[' as shell syntax.
    if (animFormat === "gif") {
      // Palette graph keeps quality + binary transparency.
      const vf = `split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse=alpha_threshold=128`;
      await $`${ff} -y -loglevel error -framerate ${fps} -i ${frames} -vf ${vf} -loop 0 ${outAnim}`.quiet();
    } else if (animFormat === "mp4") {
      // MP4/H.264 has no alpha → transparent areas flatten to black. Even dims required.
      // crf 18 + slow preset keeps avatars/text sharp.
      const vf = `scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
      await $`${ff} -y -loglevel error -framerate ${fps} -i ${frames} -vf ${vf} -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an ${outAnim}`.quiet();
    } else {
      // Animated WebP, alpha preserved. q:v 90 keeps avatars/text crisp.
      await $`${ff} -y -loglevel error -framerate ${fps} -i ${frames} -c:v libwebp_anim -loop 0 -lossless 0 -q:v 90 -compression_level 6 -preset picture -an ${outAnim}`.quiet();
    }
    log.success(`animated ${animFormat.toUpperCase()} encoded → ${outAnim}`);

    // Cleanup temp
    try {
      unlinkSync(tmpAnimPath);
      rmSync(framesDir, { recursive: true, force: true });
      rmSync(compositeDir, { recursive: true, force: true });
    } catch {}

    return outAnim;
  } catch (e) {
    log.fail(
      "animated render failed, falling back to static PNG – " +
        String(e).slice(0, 120),
    );
    const canvas = new Canvas(totalWidth, totalHeight);
    const ctx = canvas.getContext("2d");
    paintFrame(ctx);
    const buffer = await canvas.toBuffer("image/png");
    writeFileSync(outPng, buffer);
    return outPng;
  }
}
