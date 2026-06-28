import createImage from "../src/utils/createImage";
import { registerFonts } from "../src/utils/registerFonts";
import { readFileSync } from "fs";

registerFonts();

console.log("Testing Quoted-Matrix renderer with realistic Matrix event payloads…");

// Convert local file to data: URL (avoids sanitize-html stripping file:// scheme)
function fileToDataUrl(filePath: string, mime = 'image/png'): string {
    const buf = readFileSync(filePath);
    return `data:${mime};base64,${buf.toString('base64')}`;
}

function makeEvent(sender: string, body: string, formatted_body?: string, msgtype = 'm.text', extra: any = {}) {
    return {
        type: 'm.room.message',
        sender,
        room_id: '!test:localhost',
        event_id: '$' + Math.random().toString(36).slice(2),
        origin_server_ts: Date.now(),
        content: {
            msgtype,
            body,
            format: formatted_body ? 'org.matrix.custom.html' : undefined,
            formatted_body,
            ...extra
        }
    };
}

function makeStickerEvent(sender: string, url: string, body = 'sticker.webp') {
    return {
        type: 'm.sticker',
        sender,
        room_id: '!test:localhost',
        event_id: '$' + Math.random().toString(36).slice(2),
        origin_server_ts: Date.now(),
        content: {
            body,
            url,
            info: { mimetype: 'image/webp', w: 512, h: 512, size: 12345 }
        }
    };
}

function makeFileEvent(sender: string, filename: string, size: number, mime: string) {
    return {
        type: 'm.room.message',
        sender,
        room_id: '!test:localhost',
        event_id: '$' + Math.random().toString(36).slice(2),
        content: {
            msgtype: 'm.file',
            body: filename,
            filename,
            url: 'mxc://example.com/abc',
            info: { mimetype: mime, size }
        }
    };
}

// Simulate real Matrix reply fallback in body (the main bug)
function makeReplyEvent(sender: string, replyToSender: string, replyBody: string, ownBody: string, formatted?: string) {
    const fallbackBody = `> <${replyToSender}> ${replyBody}\n\n${ownBody}`;
    return {
        type: 'm.room.message',
        sender,
        room_id: '!test:localhost',
        event_id: '$' + Math.random().toString(36).slice(2),
        content: {
            msgtype: 'm.text',
            body: fallbackBody,
            format: formatted ? 'org.matrix.custom.html' : undefined,
            formatted_body: formatted,
            'm.relates_to': { 'm.in_reply_to': { event_id: '$someevent123' } }
        }
    };
}

async function run() {
    // data: URLs survive sanitize-html (file:// scheme is not in allowedSchemes for img)
    const emojiImg = fileToDataUrl('test/assets/emoji.png');
    const stickerImg = 'file://' + process.cwd().replace(/\\/g, '/') + '/test/assets/sticker.png';

    const outputs: string[] = [];

    // ── Test 1: Latin + Cyrillic + Math Unicode (𝐕𝐀𝐈) + emoji ─────────────────
    console.log("\n[1] Latin + Cyrillic + Math Unicode + emoji");
    const e1 = makeEvent(
        '@alice:matrix.org',
        'Test: 𝐕𝐀𝐈 𝕋𝔼𝕊𝕋 😀🎉🔥 Привет мир',
        'Test: <b>𝐕𝐀𝐈</b> <i>𝕋𝔼𝕊𝕋</i> 😀🎉🔥 <b>Привет</b> мир'
    );
    outputs.push(await createImage([e1]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 2: Chinese / CJK characters ─────────────────────────────────────
    console.log("\n[2] CJK – Chinese, Japanese, Korean");
    const e2 = makeEvent(
        '@bob:matrix.org',
        '你好世界！ こんにちは 안녕하세요 中文测试',
        '你好世界！ <b>こんにちは</b> 안녕하세요 <i>中文测试</i>'
    );
    outputs.push(await createImage([e2]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 3: Inline custom emoji (Matrix data-mx-emoticon) ─────────────────
    console.log("\n[3] Inline custom emoji (data-mx-emoticon)");
    const e3 = makeEvent(
        '@carol:matrix.org',
        'Hello with custom emoji and more text! А также жирный и курсив',
        `Hello with custom emoji <img src="${emojiImg}" alt=":wave:" width="20" height="20" data-mx-emoticon /> and more text! А также <b>жирный</b> и <i>курсив</i>`
    );
    outputs.push(await createImage([e3]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 4: Sticker ───────────────────────────────────────────────────────
    console.log("\n[4] Sticker event");
    const e4 = makeStickerEvent('@dave:matrix.org', stickerImg);
    outputs.push(await createImage([e4]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 5: File attachments ──────────────────────────────────────────────
    console.log("\n[5] File attachments (PDF + ZIP + MP3)");
    const e5a = makeFileEvent('@eve:matrix.org', 'report-Q4-2024.pdf', 2457600, 'application/pdf');
    const e5b = makeFileEvent('@eve:matrix.org', 'archive.zip', 10485760, 'application/zip');
    const e5c = makeFileEvent('@frank:matrix.org', 'track.mp3', 4200000, 'audio/mpeg');
    outputs.push(await createImage([e5a, e5b, e5c]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 6: Code block (highlights) ──────────────────────────────────────
    console.log("\n[6] Code block with syntax highlight");
    const e6 = makeEvent(
        '@grace:matrix.org',
        'Look at this code:\n```typescript\nconst greet = (name: string) => `Hello, ${name}!`;\nconsole.log(greet("Matrix"));\n```',
        'Look at this code:\n<pre><code class="language-typescript">const greet = (name: string) =&gt; `Hello, ${name}!`;\nconsole.log(greet("Matrix"));</code></pre>'
    );
    outputs.push(await createImage([e6]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 7: Reply with Matrix fallback body (the bug we fixed) ────────────
    console.log("\n[7] Reply event with Matrix fallback body (reply bug)");
    const e7 = makeReplyEvent(
        '@heidi:matrix.org',
        '@alice:matrix.org',
        'Original message with some text here',
        'That\'s great!',
        '<mx-reply><blockquote><a href="https://matrix.to/#/!test:localhost/$ev">In reply to</a> <a href="https://matrix.to/#/@alice:matrix.org">@alice:matrix.org</a><br>Original message</blockquote></mx-reply>That\'s great!'
    );
    outputs.push(await createImage([e7]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 8: Mixed realistic Matrix bridge conversation ────────────────────
    console.log("\n[8] Full conversation: Cyrillic + math + sticker + file");
    const emojiDataUrl = fileToDataUrl('test/assets/emoji.png');
    const e8a = makeEvent('@alice:matrix.org',
        'Всем привет! 𝐕𝐀𝐈 тест 😀',
        'Всем привет! <b>𝐕𝐀𝐈</b> тест 😀 <img src="' + emojiDataUrl + '" width="20" height="20" data-mx-emoticon alt=":fire:" />'
    );
    const e8b = makeStickerEvent('@bob:matrix.org', stickerImg);
    const e8c = makeFileEvent('@carol:matrix.org', 'presentation.pptx', 5242880, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    const e8d = makeEvent('@dave:matrix.org',
        '你好！ 这是一个测试。 こんにちは！',
        '<b>你好！</b> 这是一个测试。 こんにちは！'
    );
    outputs.push(await createImage([e8a, e8b, e8c, e8d]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 9: Spoiler + blockquote + underline ──────────────────────────────
    console.log("\n[9] Spoiler, blockquote, underline, strikethrough");
    const e9 = makeEvent(
        '@ivan:matrix.org',
        'Some formatted text',
        '<blockquote>Quoted text here</blockquote><u>underlined</u> and <del>strikethrough</del> and <span data-mx-spoiler="">hidden spoiler</span>'
    );
    outputs.push(await createImage([e9]));
    console.log(" →", outputs[outputs.length - 1]);

    // ── Test 10: Long text that wraps ─────────────────────────────────────────
    console.log("\n[10] Long wrapping text");
    const e10 = makeEvent(
        '@jack:matrix.org',
        'This is a very long message that should wrap to multiple lines. It contains various Unicode: émojis 🚀, Кириллица, 数学符号 ∑∫∂∇, and more regular latin text to fill the bubble properly.',
        'This is a very long message that should wrap to multiple lines. It contains various Unicode: émojis 🚀, <b>Кириллица</b>, 数学符号 ∑∫∂∇, and more regular latin text to fill the bubble properly.'
    );
    outputs.push(await createImage([e10]));
    console.log(" →", outputs[outputs.length - 1]);

    console.log("\n✅ All tests done. Check tmp/ for output PNGs:");
    outputs.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
}

run().catch(e => { console.error(e); process.exit(1); });
