// import { randomUUID } from "node:crypto";
import htmlToImage from "node-html-to-image";
import { readFileSync } from "node:fs";
import client from "../services/matrix";
import config from "../services/config";
import { sanitizeEventHtml } from "./sanitizeHtml";
import createFileId from "./createFileId";

const template = readFileSync('templates/message.html', 'utf-8');

function mxcToHttpThumbnail(mxcUrl: string, width: number, height: number, method: string): string {
    const parts = mxcUrl.replace('mxc://', '').split('/');
    const serverName = parts[0];
    const mediaId = parts.slice(1).join('/');
    return `${config.matrix.homeserverUrl}/_matrix/client/v1/media/thumbnail/${serverName}/${mediaId}?width=${width}&height=${height}&method=${method}`;
}

export default async function createImage(events: any[]): Promise<string> {
    const fileName = `tmp/${createFileId(events)}.png`;

    const eventsForHtml = [];

    for (const event of events) {
        let displayname = event.sender;
        let avatarUrl: string | null = null;
        let reply: string | null = null;

        const replyToId = event.content['m.relates_to']?.['m.in_reply_to']?.event_id;

        try {
            const profile = await client.getProfileInfo(event.sender);

            displayname = profile.displayname || event.sender;
            avatarUrl = profile.avatar_url ? `${mxcToHttpThumbnail(profile.avatar_url, 128, 128, 'scale')}&access_token=${client.getAccessToken()}` : null;
        } catch (e) {
            // Use sender as fallback
        }

        if (typeof replyToId === 'string') {
            try {
                const replyTo = await client.fetchRoomEvent(event.room_id, event.event_id);
                let replyDisplayname: string = replyTo.sender;

                try {
                    const profile = await client.getProfileInfo(replyTo.sender);

                    replyDisplayname = profile.displayname;
                } catch (e) {
                    
                }

                if (typeof replyTo.content?.body === 'string') {
                    const replyBodyHtml = replyTo.content.formatted_body
                        ? sanitizeEventHtml(replyTo.content.formatted_body)
                        : escapeHtml(replyTo.content.body);
                    reply = `<b>${escapeHtml(replyDisplayname)}:</b> ${replyBodyHtml}${replyTo.content.msgtype !== 'm.text' ? ` (${escapeHtml(replyTo.content.msgtype)})` : ''}`;
                }
            } catch (error) {
                reply = `<i>Failed to load reply</i>`;
            }
        }

        eventsForHtml.push({
            ...event,
            unsigned: {
                displayname,
                avatar_url: avatarUrl,
                reply,
            },
        });
    }

    await htmlToImage({
        html: template.replace('<!-- MESSAGES -->', eventsForHtml.map(x => renderEvent(x)).join('')),
        output: fileName,
        transparent: true,
        type: 'png',
        waitUntil: 'networkidle0',
        puppeteerArgs: {
            args: config.puppeteerNoSandbox ? ['--no-sandbox'] : [],
        },
        async beforeScreenshot(page) {
            // Resize viewport to fit the actual content, removing empty space
            const dimensions = await page.evaluate(() => {
                const body = document.body;
                return {
                    width: body.scrollWidth,
                    height: body.scrollHeight,
                };
            });
            await page.setViewport({
                width: Math.ceil(dimensions.width),
                height: Math.ceil(dimensions.height),
                deviceScaleFactor: 2,
            });
        },
    });

    return fileName;
}

function escapeHtml(text: string): string {
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMessageBody(content) {
    const msgtype = content.msgtype;

    switch (msgtype) {
        case 'm.text': {
            const bodyHtml = content.format === 'org.matrix.custom.html' && content.formatted_body
                ? sanitizeEventHtml(content.formatted_body)
                : escapeHtml(content.body);
            return `<div class="message-body">${bodyHtml}</div>`;
        }
        case 'm.notice': {
            const bodyHtml = content.format === 'org.matrix.custom.html' && content.formatted_body
                ? sanitizeEventHtml(content.formatted_body)
                : escapeHtml(content.body);
            return `<div class="message-body notice">${bodyHtml}</div>`;
        }
        case 'm.image': {
            const url = content.url || '';
            const alt = escapeHtml(content.body || 'image');
            return `<div class="message-image"><img src="${escapeHtml(url)}" alt="${alt}" /></div>`;
        }
        case 'm.video':
        case 'm.audio':
        default: {
            return `<div class="unsupported">Unsupported ${escapeHtml(msgtype)}</div>`;
        }
    }
}

function renderEvent(event) {
    if (event.type !== 'm.room.message') return '';

    const displayname = (event.unsigned && event.unsigned.displayname) || event.sender;
    const avatarUrl = event.unsigned && event.unsigned.avatar_url;
    const reply = event.unsigned && event.unsigned.reply;

    const avatarHtml = avatarUrl
        ? `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="" />`
        : `<div class="avatar"></div>`;

    const bodyHtml = renderMessageBody(event.content);

    return `
                <div class="message">
                    ${avatarHtml}
                    <div class="message-content">
                        <div class="bubble">
                            <div class="message-header">
                                <span class="displayname">${escapeHtml(displayname)}</span>
                            </div>
                            ${reply ? `<div class="reply">${reply}</div>` : ''}
                            ${bodyHtml}
                        </div>
                    </div>
                </div>
            `;
}
