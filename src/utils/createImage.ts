import client from "../services/matrix";
import config from "../services/config";
import createFileId from "./createFileId";
import { Canvas, Image } from "@napi-rs/canvas";
import { loadCanvasImage, fillRoundRect } from "./canvasUtils";
import { writeFileSync } from "node:fs";
import { sanitizeEventHtml } from "./sanitizeHtml";
import { parseHtml, layoutRichText, drawRichText, Token, ImageToken, MeasureOracle } from "./RichTextRenderer";
import hljs from "highlight.js";

interface CreateImageOptions {
    hideReplies?: boolean;
}

function highlightCodeBlocks(html: string): string {
    return html.replace(/<pre><code(.*?)>([\s\S]*?)<\/code><\/pre>/gi, (match, attr, code) => {
        // Decode basic html entities before passing to highlight.js
        const unescaped = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        const langMatch = attr.match(/class=["'].*?language-([^ "']+).*?["']/);
        const lang = langMatch ? langMatch[1] : undefined;
        let highlighted = '';
        try {
            if (lang && hljs.getLanguage(lang)) {
                highlighted = hljs.highlight(unescaped, { language: lang }).value;
            } else {
                highlighted = hljs.highlightAuto(unescaped).value;
            }
        } catch(e) { 
            highlighted = code; 
        }
        // Force pre context in our renderer
        return `<pre><code${attr}>${highlighted}</code></pre>`;
    });
}

function mxcToHttpThumbnail(mxcUrl: string, width: number, height: number, method: string): string {
    const parts = mxcUrl.replace('mxc://', '').split('/');
    const serverName = parts[0];
    const mediaId = parts.slice(1).join('/');
    return `${config.matrix.homeserverUrl}/_matrix/client/v1/media/thumbnail/${serverName}/${mediaId}?width=${width}&height=${height}&method=${method}`;
}

export default async function createImage(events: any[], options: CreateImageOptions = {}): Promise<string> {
    const fileName = `tmp/${createFileId(events)}.png`;
    const PADDING = 12;
    const AVATAR_SIZE = 36;
    const AVATAR_GAP = 10;
    const BUBBLE_PAD_X = 12;
    const BUBBLE_PAD_Y = 8;
    const TEXT_MAX_WIDTH = 400;
    const LINE_HEIGHT = 20;

    const parsedEvents = [];

    // Pre-flight: gather data and load images
    for (const event of events) {
        if (event.type !== 'm.room.message') continue;
        
        let displayname = event.sender;
        let avatarUrl: string | null = null;
        let avatarImage: Image | null = null;
        let reply = null;
        let attachedImage: Image | null = null;
        let attachedImageSize = { width: 0, height: 0 };
        let tokens: Token[] = [];

        try {
            const profile = await client.getProfileInfo(event.sender);
            displayname = profile.displayname || event.sender;
            if (profile.avatar_url) {
                avatarUrl = `${mxcToHttpThumbnail(profile.avatar_url, 128, 128, 'scale')}&access_token=${client.getAccessToken()}`;
                avatarImage = await loadCanvasImage(avatarUrl);
            }
        } catch (e) {
            // fallback
        }

        // Handle Replies
        const replyToId = event.content['m.relates_to']?.['m.in_reply_to']?.event_id;
        if (!options.hideReplies && typeof replyToId === 'string') {
            try {
                const replyEvent = await client.fetchRoomEvent(event.room_id, replyToId);
                let replyName = replyEvent.sender;
                try {
                    const repProfile = await client.getProfileInfo(replyEvent.sender);
                    replyName = repProfile.displayname || replyEvent.sender;
                } catch (e) {}

                let repHtml = replyEvent.content?.body || "Unsupported reply";
                if (replyEvent.content?.format === 'org.matrix.custom.html' && replyEvent.content?.formatted_body) {
                    repHtml = highlightCodeBlocks(sanitizeEventHtml(replyEvent.content.formatted_body));
                } else if (replyEvent.content?.msgtype === 'm.image') {
                    repHtml = "🖼️ [Image]";
                } else {
                    repHtml = repHtml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
                }
                
                reply = { 
                    displayname: replyName, 
                    tokens: parseHtml(repHtml) 
                };
            } catch (e) {
                reply = { displayname: "Unknown", tokens: [{ type: 'text', text: "Failed to load reply", style: { bold: false, italic: false, code: false, pre: false, strike: false, underline: false, blockquote: false, spoiler: false, size: 14, color: null, codeLang: null } }] };
            }
        }

        // Handle Text and Images
        if (event.content.msgtype === 'm.image' && event.content.url) {
            const imgUrl = `${mxcToHttpThumbnail(event.content.url, 400, 400, 'scale')}&access_token=${client.getAccessToken()}`;
            attachedImage = await loadCanvasImage(imgUrl);
            if (attachedImage) {
                const MAX_W = 300;
                const MAX_H = 300;
                let w = attachedImage.width;
                let h = attachedImage.height;
                if (w > MAX_W) { h = h * (MAX_W / w); w = MAX_W; }
                if (h > MAX_H) { w = w * (MAX_H / h); h = MAX_H; }
                attachedImageSize = { width: w, height: h };
            }
            // Often images have the filename as the body. Let's only render text if it's explicitly a caption
            let bodyText = event.content?.body || "";
            const isRawFilename = /^[\w\-_ \(\)]+\.(png|jpg|jpeg|gif|webp)$/i.test(bodyText.trim());
            if (!isRawFilename && bodyText.trim() !== "") {
                let htmlBody = bodyText;
                if (event.content.format === 'org.matrix.custom.html' && event.content.formatted_body) {
                    htmlBody = highlightCodeBlocks(sanitizeEventHtml(event.content.formatted_body));
                } else {
                    htmlBody = htmlBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
                }
                tokens = parseHtml(htmlBody);
            }
        } else {
            let htmlBody = event.content?.body || "";
            if (event.content.format === 'org.matrix.custom.html' && event.content.formatted_body) {
                htmlBody = highlightCodeBlocks(sanitizeEventHtml(event.content.formatted_body));
            } else {
                htmlBody = htmlBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
            }
            tokens = parseHtml(htmlBody);
        }

        // Preload inline images (emojis) for body
        for (const token of tokens) {
            if (token.type === 'image') {
                const imgToken = token as ImageToken;
                imgToken.imageObj = await loadCanvasImage(imgToken.src) || undefined;
            }
        }

        // Preload inline images (emojis) for reply
        if (reply) {
            for (const token of reply.tokens) {
                if (token.type === 'image') {
                    const imgToken = token as ImageToken;
                    imgToken.imageObj = await loadCanvasImage(imgToken.src) || undefined;
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
                attachedImageSize
            }
        });
    }

    // Measure Layout
    const measureCanvas = new Canvas(1, 1);
    const measureCtx = measureCanvas.getContext("2d");
    const oracle = new MeasureOracle(measureCtx);

    let totalHeight = PADDING;
    let totalWidth = 0;

    for (const event of parsedEvents) {
        // Measure Display Name
        const nameWidth = oracle.measure(event.parsed.displayname, "bold 14px sans-serif");

        // Measure Reply
        let replyLines: any[] = [];
        let replyWidth = 0;
        let replyHeight = 0;
        if (event.parsed.reply) {
            const prefixToken: Token = { type: 'text', text: event.parsed.reply.displayname + ": ", style: { bold: true, italic: false, code: false, pre: false, strike: false, underline: false, blockquote: false, spoiler: false, size: 14, color: null, codeLang: null } };
            const replyTokens = [prefixToken, ...event.parsed.reply.tokens];
            
            replyLines = layoutRichText(oracle, replyTokens, TEXT_MAX_WIDTH - 16);
            
            // Limit reply to 2 lines max
            if (replyLines.length > 2) {
                replyLines = [replyLines[0], replyLines[1]];
                replyLines[1].items.push({ type: 'text', text: "...", style: { bold: false, italic: false, code: false, pre: false, strike: false, underline: false, blockquote: false, spoiler: false, size: 14, color: null, codeLang: null }, x: replyLines[1].width, w: oracle.measure("...", "14px sans-serif") });
            }
            
            for (const line of replyLines) {
                replyHeight += line.height;
                const w = line.width + 16; // 16px for border & padding
                if (w > replyWidth) replyWidth = w;
            }
            if (replyLines.length > 0) replyHeight += 8; // extra padding
        }

        // Measure Body
        const lines = layoutRichText(oracle, event.parsed.tokens, TEXT_MAX_WIDTH);
        
        let maxLineWidth = 0;
        let textHeight = 0;
        for (const line of lines) {
            if (line.width > maxLineWidth) maxLineWidth = line.width;
            textHeight += line.height;
        }

        const imgWidth = event.parsed.attachedImageSize.width;
        const imgHeight = event.parsed.attachedImageSize.height;

        const bubbleWidth = Math.max(nameWidth, maxLineWidth, replyWidth, imgWidth) + BUBBLE_PAD_X * 2;
        
        // Calculate total bubble height adding components sequentially
        let innerHeight = LINE_HEIGHT; // Name height
        if (replyHeight > 0) innerHeight += replyHeight + 4; // Reply + gap
        if (lines.length > 0 && maxLineWidth > 0) innerHeight += textHeight;
        if (imgHeight > 0) innerHeight += imgHeight + ((textHeight > 0 || replyHeight > 0) ? 8 : 0); // Image + gap

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
            maxLineWidth
        };

        totalHeight += rowHeight + 8; // 8px gap between messages
        if (rowWidth > totalWidth) totalWidth = rowWidth;
    }

    totalHeight = totalHeight - 8 + PADDING; // Remove last gap, add bottom padding
    if (totalWidth < 200) totalWidth = 200; // minimum width

    // Paint
    const canvas = new Canvas(totalWidth, totalHeight);
    const ctx = canvas.getContext("2d");

    let currentY = PADDING;

    for (const event of parsedEvents) {
        const { lines, replyLines, replyHeight, bubbleWidth, bubbleHeight, rowHeight, maxLineWidth } = event.layout;
        const startX = PADDING;

        // Draw Avatar
        if (event.parsed.avatarImage) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(startX + AVATAR_SIZE / 2, currentY + AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(event.parsed.avatarImage, startX, currentY, AVATAR_SIZE, AVATAR_SIZE);
            ctx.restore();
        } else {
            ctx.fillStyle = "#5865f2";
            ctx.beginPath();
            ctx.arc(startX + AVATAR_SIZE / 2, currentY + AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.fill();
        }

        // Draw Bubble
        const bubbleX = startX + AVATAR_SIZE + AVATAR_GAP;
        ctx.fillStyle = "#1e1e2e";
        fillRoundRect(ctx, bubbleX, currentY, bubbleWidth, bubbleHeight, { tl: 4, tr: 12, bl: 12, br: 12 });

        let contentTop = currentY + BUBBLE_PAD_Y;

        // Draw Display Name
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 14px sans-serif";
        ctx.fillText(event.parsed.displayname, bubbleX + BUBBLE_PAD_X, contentTop + 14); // 14 is baseline
        contentTop += LINE_HEIGHT;

        // Draw Reply
        if (event.parsed.reply && replyLines.length > 0) {
            const repX = bubbleX + BUBBLE_PAD_X;
            
            // Draw left border
            ctx.fillStyle = "#4a4a59"; // muted purple/gray border
            ctx.beginPath();
            ctx.roundRect(repX, contentTop, 3, replyHeight - 8, 2);
            ctx.fill();

            contentTop = drawRichText(ctx, replyLines, repX + 10, contentTop, bubbleWidth - BUBBLE_PAD_X * 2 - 10, "#aaaaaa");
            contentTop += 4; // advance cursor + gap
        }

        // Draw Text Lines
        if (lines.length > 0 && maxLineWidth > 0) {
            contentTop = drawRichText(ctx, lines, bubbleX + BUBBLE_PAD_X, contentTop, bubbleWidth - BUBBLE_PAD_X * 2, "#e1e1e1");
        }

        // Draw Image
        if (event.parsed.attachedImage) {
            if (contentTop > currentY + BUBBLE_PAD_Y + LINE_HEIGHT) {
                contentTop += 8; // add gap if there is text or reply above
            }
            const { width: w, height: h } = event.parsed.attachedImageSize;
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(bubbleX + BUBBLE_PAD_X, contentTop, w, h, 8);
            ctx.clip();
            ctx.drawImage(event.parsed.attachedImage, bubbleX + BUBBLE_PAD_X, contentTop, w, h);
            ctx.restore();
        }

        currentY += rowHeight + 8;
    }

    const buffer = await canvas.toBuffer("image/png");
    writeFileSync(fileName, buffer);

    return fileName;
}
