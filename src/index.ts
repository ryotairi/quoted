import client from "./services/matrix";
import config from "./services/config";
import createImage from "./utils/createImage";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { RoomEvent, RoomMemberEvent, Direction } from "matrix-js-sdk";
import createFileId from "./utils/createFileId";
import { createLogger } from "./utils/logger";

const log = createLogger('bot');

// Ensure tmp directory exists
if (!existsSync('tmp')) mkdirSync('tmp', { recursive: true });

const startTime = Date.now();
log.info(`Quoted-Matrix starting – userId=${config.matrix.userId}, animatedStickers=${config.render.animatedStickers}, transparentBg=${config.render.transparentBackground}`);

// Auto-join rooms on invite
client.on(RoomMemberEvent.Membership, async (event, member) => {
    if (event.localTimestamp < startTime) return;
    if (member.membership === 'invite' && member.userId === config.matrix.userId) {
        log.info(`Invited to room ${member.roomId}, joining…`);
        try {
            await client.joinRoom(member.roomId);
            log.info(`Joined ${member.roomId}`);
        } catch (err) {
            log.error(`Failed to join room ${member.roomId}:`, err);
        }
        try {
            await client.sendHtmlNotice(member.roomId, config.welcomeText, config.welcomeText);
        } catch (err) {
            log.error(`Failed to send welcome to ${member.roomId}:`, err);
        }
    }
});

client.on(RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
    if (toStartOfTimeline) return;
    if (event.localTimestamp < startTime) return;
    if (event.getType() !== 'm.room.message') return;

    const sender = event.getSender();
    if (sender === config.matrix.userId) return;

    const content = event.getContent();
    if (content.msgtype !== 'm.text') return;

    const prefix = (config as any).commandPrefix || '..';
    const quoteCmd = `${prefix}${(config as any).commands?.quote || 'q'}`;
    const helpCmd = `${prefix}${(config as any).commands?.help || 'help'}`;

    // Strip Matrix reply fallback ("> quote\n\n actual message" added by clients)
    let body = (content.body || '').trim();
    if (body.startsWith('> ')) {
        const sep = body.indexOf('\n\n');
        if (sep !== -1) body = body.slice(sep + 2).trim();
    }
    if (!body.startsWith(prefix)) return;

    const args = body.slice(prefix.length).trim().split(/\s+/);
    const cmdName = args.shift() || '';

    const fullCmd = prefix + cmdName;

    if (fullCmd === quoteCmd) {
        const replyTo = content['m.relates_to']?.['m.in_reply_to']?.event_id;
        if (typeof replyTo !== 'string') {
            await client.sendHtmlNotice(room.roomId, '', '<b>Please reply to a message!</b>');
            return;
        }

        let hideReplies = false;
        let count = 0;
        for (const arg of args) {
            if (arg === '-c') { hideReplies = true; continue; }
            const parsedCount = parseInt(arg, 10);
            if (!isNaN(parsedCount) && parsedCount > 0) count = Math.min(parsedCount, 20);
        }

        log.info(`Quote request in ${room.roomId} – replyTo=${replyTo} count=${count} hideReplies=${hideReplies}`);

        try {
            if (count > 10) {
                await client.sendNotice(room.roomId, `${count} is too large! Maximum is 10`);
                return;
            }
            const replyToEvent = await client.fetchRoomEvent(room.roomId, replyTo);
            const allEvents = [replyToEvent];

            if (count > 0) {
                let timeline = room.getTimelineForEvent(replyTo);
                if (!timeline) {
                    for (const set of room.getTimelineSets()) {
                        timeline = await client.getEventTimeline(set, replyTo);
                    }
                }
                const index = timeline.getEvents().findIndex(x => x.getId() == replyTo);
                const events = timeline.getEvents();
                for (let i = index + 1; i <= index + count; i++) {
                    try { if (events[i]) allEvents.push(events[i].event); } catch {}
                }
            }

            log.debug(`Rendering ${allEvents.length} event(s)…`);
            const filePath = await createImage(allEvents, { hideReplies });
            const imageData = readFileSync(filePath);

            const isWebp = filePath.endsWith('.webp');
            const mimeType = isWebp ? 'image/webp' : 'image/png';
            const fileName = isWebp ? 'sticker.webp' : 'sticker.png';

            log.info(`Uploading ${fileName} ${(imageData.length/1024).toFixed(1)}KB …`);
            const uploadResponse = await client.uploadContent(imageData, { name: fileName, type: mimeType });
            const mxcUrl = uploadResponse.content_uri;
            log.info(`Uploaded → ${mxcUrl}`);

            // Send as sticker
            // @ts-ignore
            await client.sendEvent(room.roomId, 'm.sticker', {
                body: fileName,
                info: { mimetype: mimeType, size: imageData.length },
                url: mxcUrl,
                'm.relates_to': { 'm.in_reply_to': { event_id: event.getId() } },
            });
            log.info(`Sticker sent to ${room.roomId}`);

            const id = createFileId(allEvents);
            const state = room.getLiveTimeline().getState(Direction.Forward);
            const roomEmotes = state.getStateEvents('im.ponies.room_emotes', 'quoted')?.getContent() ?? {};
            const images = roomEmotes && typeof roomEmotes.images === 'object' ? roomEmotes.images : {};
            const pack = roomEmotes && typeof roomEmotes.pack === 'object' ? roomEmotes.pack : null;
            if (images[id]) {
                log.debug(`Sticker ${id} already in pack, skipping state event`);
                return;
            }
            images[id] = { url: mxcUrl, info: { mimetype: mimeType, size: imageData.length } };

            if (state.mayClientSendStateEvent('im.ponies.room_emotes', client)) {
                // @ts-ignore
                await client.sendStateEvent(room.roomId, 'im.ponies.room_emotes', { images, pack: pack ?? { display_name: 'Quoted', usage: ['sticker'] } }, 'quoted');
                log.info(`Added sticker ${id} to room pack`);
            } else {
                log.warn(`No permission to send im.ponies.room_emotes in ${room.roomId}`);
                client.sendHtmlNotice(room.roomId, '', '<i>Could not create "Quoted" sticker pack, can\'t send state event "im.ponies.room_emotes"</i>').catch(()=>{});
            }
        } catch (err) {
            log.error('Error processing quote:', err);
            client.sendHtmlNotice(room.roomId, '', '<b>Failed to create quote image.</b>').catch(()=>{});
        }
    } else if (fullCmd === helpCmd) {
        client.sendHtmlNotice(room.roomId, config.helpText, config.helpText).catch(e => log.error('help send failed', e));
    }
});

client.startClient({ initialSyncLimit: 0 }).then(() => {
    log.info('Matrix client ready!');
});
