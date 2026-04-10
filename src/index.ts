import client from "./services/matrix";
import config from "./services/config";
import createImage from "./utils/createImage";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { RoomEvent, RoomMemberEvent, Membership, Direction, MsgType } from "matrix-js-sdk";
import createFileId from "./utils/createFileId";
import { join } from 'path';

// Ensure tmp directory exists
if (!existsSync('tmp')) {
    mkdirSync('tmp');
}

const startTime = Date.now();
// Auto-join rooms on invite
client.on(RoomMemberEvent.Membership, async (event, member) => {
    if (event.localTimestamp < startTime) return;
    if (member.membership === 'invite' && member.userId === config.matrix.userId) {
        try {
            await client.joinRoom(member.roomId);
        } catch (err) {
            console.error(`Failed to join room ${member.roomId}:`, err);
        }

        try {
            await client.sendHtmlNotice(member.roomId, config.welcomeText, config.welcomeText);
        } catch (err) {
            console.error(`Failed to send a message ${member.roomId}:`, err);
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

    const args = content.body.split(' ');
    const cmd = args.shift();

    if (cmd === '..q') {
        const replyTo = content['m.relates_to']?.['m.in_reply_to']?.event_id;
        if (typeof replyTo !== 'string') {
            await client.sendHtmlNotice(room.roomId, '', '<b>Please reply to a message!</b>');
            return;
        }

        // Parse optional count of additional messages after the replied-to message
        const extraCount = args.length > 0 ? parseInt(args[0], 10) : 0;
        const count = (!isNaN(extraCount) && extraCount > 0) ? Math.min(extraCount, 20) : 0;

        try {
            if (count > 10) {
                await client.sendNotice(room.roomId, `${count} is a too large value! Maximum is 10`);
		return;
            }
            // Fetch the replied-to event
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
                    try {
                        if (events[i])
                            allEvents.push(events[i].event);
                    } catch (error) {

                    }
                }
            }

            const filePath = await createImage(allEvents);
            const imageData = readFileSync(filePath);

            // Upload the image
            const uploadResponse = await client.uploadContent(imageData, {
                name: 'image.png',
                type: 'image/png',
            });

            const mxcUrl = uploadResponse.content_uri;

            // Send as sticker
            // @ts-ignore
            await client.sendEvent(room.roomId, 'm.sticker', {
                body: 'image.png',
                info: {
                    mimetype: 'image/png',
                    size: imageData.length,
                },
                url: mxcUrl,
                'm.relates_to': {
                    'm.in_reply_to': {
                        event_id: event.getId(),
                    },
                },
            });

            const id = createFileId(allEvents);
            const state = room.getLiveTimeline().getState(Direction.Forward);
            const roomEmotes = state.getStateEvents('im.ponies.room_emotes', 'quoted')?.getContent() ?? {};
            const images = roomEmotes && typeof roomEmotes.images === 'object' ? roomEmotes.images : {};
            const pack = roomEmotes && typeof roomEmotes.pack === 'object' ? roomEmotes.pack : null;
            if (images[id]) return;

            images[id] = {
                info: {
                    mimetype: 'image/png',
                    size: imageData.length,
                },
                url: mxcUrl,
            };

            if (state.mayClientSendStateEvent('im.ponies.room_emotes', client)) {
                // @ts-ignore
                await client.sendStateEvent(room.roomId, 'im.ponies.room_emotes', { 
                    images, 
                    pack: pack ?? {
                        display_name: 'Quoted',
                        usage: ['sticker']
                    }
                 }, 'quoted');
            } else {
                client.sendHtmlNotice(room.roomId, '', '<i>Could not create "Quoted" sticker pack, can\'t send state event "im.ponies.room_emotes"</i>').catch(console.error);
            }
        } catch (err) {
            console.error('Error processing quote:', err);
            client.sendHtmlNotice(room.roomId, '', '<b>Failed to create quote image.</b>').catch(console.error);
        }
    } else if (cmd === '..help') {
        client.sendHtmlNotice(room.roomId, config.helpText, config.helpText).catch(console.error);
    } else if (cmd === '..peter-griffin') {
        // peter griffin
        const buffer: Buffer = readFileSync(join(__dirname, '..', 'resources', 'peter.png'));
        const uploadResponse = await client.uploadContent(new Uint8Array(buffer), {
            "name": 'peter.png',
            "type": 'image/png'
        });
        const mxcUrl = uploadResponse.content_uri;
        await client.sendMessage(room.roomId, {
            msgtype: MsgType.Image,
            body: 'peter.png',
            url: mxcUrl,
            info: {
                mimetype: 'image/png',
                size: buffer.length
            }
        });
    }
});

client.startClient({ initialSyncLimit: 0 }).then(() => {
    console.log('Client ready!');
});
