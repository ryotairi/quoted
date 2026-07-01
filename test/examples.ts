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
    // Pick the first candidate whose media actually downloads (skip retention-deleted ones).
    let animEvent: Ev | null = null;
    for (const e of animated) {
        const mxc = e.content?.url;
        if (!mxc?.startsWith('mxc://')) continue;
        const [s, i] = [mxc.slice(6).split('/')[0], mxc.slice(6).split('/').slice(1).join('/').split('#')[0]];
        const res = await fetch(`${HS}/_matrix/client/v1/media/download/${s}/${i}`, { headers: auth, signal: AbortSignal.timeout(15000) }).catch(() => null);
        if (res?.ok) { animEvent = e; break; }
    }
    if (animEvent) {
        for (const fmt of ['webp', 'gif', 'mp4'] as const) {
            (config.render as any).animatedFormat = fmt;
            await save(`03-animated-${fmt}`, [animEvent]);
        }
        (config.render as any).animatedFormat = 'webp';
    } else {
        log.fail('no fetchable animated media found for examples');
    }

    // 4. A short conversation (mix of senders)
    const convo: Ev[] = [];
    const seen = new Set<string>();
    for (const e of events.filter(e => isMsg(e, 'm.text') && (e.content.body || '').length > 2)) {
        if (!seen.has(e.sender)) { seen.add(e.sender); convo.push(e); }
        if (convo.length >= 3) break;
    }
    if (convo.length >= 2) await save('04-conversation', convo.reverse());

    // 5. Placeholder – a quote whose attachment can't be fetched (retention-deleted etc.)
    const realSender = texts[0]?.sender || '@telegram_2006932399:extera.xyz';
    const deadGif: Ev = {
        type: 'm.room.message', sender: realSender,
        room_id: events[0]?.room_id || '!unknown:extera.xyz',
        content: { msgtype: 'm.video', body: 'lost.gif',
            url: 'mxc://extera.xyz/DEADdeadDEADdeadDEADdead',
            info: { mimetype: 'image/gif', w: 256, h: 256, size: 1 } },
    };
    (config.render as any).animatedFormat = 'webp';
    await save('05-placeholder', [deadGif]);

    log.info('done – see examples/');
}

main().catch(e => { console.error(e); process.exit(1); });
