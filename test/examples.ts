/**
 * Generate real showcase stickers for the README using live Matrix data
 * (real users, real avatars, real stickers). Outputs into examples/.
 *   bun run test/examples.ts
 */
import config from "../src/services/config";
import createImage from "../src/utils/createImage";
import { registerFonts } from "../src/utils/registerFonts";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { createLogger } from "../src/utils/logger";

registerFonts();
const log = createLogger('examples');
const HS = config.matrix.homeserverUrl;
const auth = { Authorization: `Bearer ${config.matrix.accessToken}` };
if (!existsSync('examples')) mkdirSync('examples', { recursive: true });

type Ev = any;

async function fetchEvents(): Promise<Ev[]> {
    const jr = await fetch(`${HS}/_matrix/client/v3/joined_rooms`, { headers: auth });
    const rooms: string[] = (await jr.json() as any).joined_rooms || [];
    const all: Ev[] = [];
    for (const roomId of rooms) {
        const r = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=100`, { headers: auth });
        for (const ev of ((await r.json()) as any).chunk || []) {
            ev.room_id = ev.room_id || roomId;
            all.push(ev);
        }
    }
    return all;
}

const isMsg = (e: Ev, t: string) => e.type === 'm.room.message' && e.content?.msgtype === t;

async function save(name: string, events: Ev[]) {
    try {
        const out = await createImage(events, { hideReplies: false });
        const ext = out.split('.').pop() || 'png';
        const dest = `examples/${name}.${ext}`;
        writeFileSync(dest, readFileSync(out));
        log.success(`${name} → ${dest}`);
    } catch (e) {
        log.fail(`${name}: ${String(e).slice(0, 120)}`);
    }
}

async function main() {
    const events = await fetchEvents();
    log.info(`fetched ${events.length} events`);

    // 1. A rich text message (prefer one with formatted_body + a sender that has an avatar)
    const texts = events.filter(e => isMsg(e, 'm.text') && (e.content.body || '').length > 12);
    if (texts[0]) await save('01-text-quote', [texts[0]]);

    // 2. A static sticker
    const stickers = events.filter(e => e.type === 'm.sticker' && /webp|png/.test(e.content?.info?.mimetype || ''));
    if (stickers[0]) await save('02-sticker', [stickers[0]]);

    // 3. An animated quote, rendered in every output format (webp / gif / mp4)
    const animated = events.filter(e =>
        (e.type === 'm.sticker' || e.content?.msgtype === 'm.video' || e.content?.msgtype === 'm.image') &&
        /gif|webm|mp4/.test(e.content?.info?.mimetype || '')
    );
    if (animated[0]) {
        for (const fmt of ['webp', 'gif', 'mp4'] as const) {
            (config.render as any).animatedFormat = fmt;
            await save(`03-animated-${fmt}`, [animated[0]]);
        }
        (config.render as any).animatedFormat = 'webp';
    }

    // 4. A short conversation (mix of senders)
    const convo: Ev[] = [];
    const seen = new Set<string>();
    for (const e of events.filter(e => isMsg(e, 'm.text') && (e.content.body || '').length > 2)) {
        if (!seen.has(e.sender)) { seen.add(e.sender); convo.push(e); }
        if (convo.length >= 3) break;
    }
    if (convo.length >= 2) await save('04-conversation', convo.reverse());

    log.info('done – see examples/');
}

main().catch(e => { console.error(e); process.exit(1); });
