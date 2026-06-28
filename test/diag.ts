/**
 * Diagnostic: probe the REAL homeserver to understand which media endpoints work.
 * Run: bun run test/diag.ts
 */
import config from "../src/services/config";

const HS = config.matrix.homeserverUrl;
const TOKEN = config.matrix.accessToken;

const auth = { Authorization: `Bearer ${TOKEN}` };

async function probe(label: string, url: string, headers: Record<string, string> = {}) {
    try {
        const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
        const ct = res.headers.get('content-type') || '';
        const cl = res.headers.get('content-length') || '?';
        let extra = '';
        if (!res.ok && ct.includes('json')) {
            extra = ' ' + (await res.text()).slice(0, 200);
        }
        console.log(`  [${res.status}] ${label}  ct=${ct} len=${cl}${extra}`);
        return res.ok;
    } catch (e) {
        console.log(`  [ERR] ${label}  ${String(e).slice(0, 120)}`);
        return false;
    }
}

async function main() {
    console.log("=== Server versions ===");
    const v = await fetch(`${HS}/_matrix/client/versions`, { headers: auth });
    const vj: any = await v.json();
    console.log("  versions:", (vj.versions || []).slice(-6).join(', '));
    console.log("  unstable_features authed_media:", vj.unstable_features?.['org.matrix.msc3916'] ?? vj.unstable_features?.['org.matrix.msc3916.stable'] ?? 'n/a');

    console.log("\n=== Media config ===");
    await probe("client/v1/media/config", `${HS}/_matrix/client/v1/media/config`, auth);

    // Find a real room with stickers/emoji
    console.log("\n=== Joined rooms ===");
    const jr = await fetch(`${HS}/_matrix/client/v3/joined_rooms`, { headers: auth });
    const jrj: any = await jr.json();
    const rooms: string[] = jrj.joined_rooms || [];
    console.log(`  ${rooms.length} rooms`);

    // Scan recent messages for media events
    let foundSticker: string | null = null;
    let foundEmoji: string | null = null;
    let foundImage: string | null = null;

    for (const roomId of rooms.slice(0, 15)) {
        if (foundSticker && foundEmoji && foundImage) break;
        try {
            const msgsRes = await fetch(
                `${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=60`,
                { headers: auth, signal: AbortSignal.timeout(10000) }
            );
            const msgs: any = await msgsRes.json();
            for (const ev of msgs.chunk || []) {
                const url = ev.content?.url;
                if (ev.type === 'm.sticker' && url?.startsWith('mxc://') && !foundSticker) {
                    foundSticker = url;
                    console.log(`  sticker in ${roomId}: ${url} mime=${ev.content?.info?.mimetype}`);
                }
                if (ev.content?.msgtype === 'm.image' && url?.startsWith('mxc://') && !foundImage) {
                    foundImage = url;
                }
                // custom emoji in formatted_body
                const fb = ev.content?.formatted_body || '';
                const m = fb.match(/<img[^>]+src="(mxc:\/\/[^"]+)"/i);
                if (m && !foundEmoji) {
                    foundEmoji = m[1];
                    console.log(`  emoji in ${roomId}: ${m[1]}`);
                }
            }
        } catch (e) {
            // skip
        }
    }

    const testMxc = async (label: string, mxc: string | null) => {
        if (!mxc) { console.log(`\n=== ${label}: none found ===`); return; }
        console.log(`\n=== ${label}: ${mxc} ===`);
        const parts = mxc.slice(6).split('/');
        const server = parts[0];
        const id = parts.slice(1).join('/').split('#')[0].split('?')[0];

        // All endpoint variants
        await probe("v1/download  +Bearer", `${HS}/_matrix/client/v1/media/download/${server}/${id}`, auth);
        await probe("v1/download  NO auth", `${HS}/_matrix/client/v1/media/download/${server}/${id}`);
        await probe("v1/thumbnail 512 scale +Bearer", `${HS}/_matrix/client/v1/media/thumbnail/${server}/${id}?width=512&height=512&method=scale`, auth);
        await probe("v1/thumbnail 64 scale +Bearer", `${HS}/_matrix/client/v1/media/thumbnail/${server}/${id}?width=64&height=64&method=scale`, auth);
        await probe("v3/download (legacy) NO auth", `${HS}/_matrix/media/v3/download/${server}/${id}`);
        await probe("v3/thumbnail(legacy) NO auth", `${HS}/_matrix/media/v3/thumbnail/${server}/${id}?width=64&height=64&method=scale`);
    };

    await testMxc("STICKER", foundSticker);
    await testMxc("EMOJI", foundEmoji);
    await testMxc("IMAGE", foundImage);

    console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
