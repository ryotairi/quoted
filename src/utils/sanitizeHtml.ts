import sanitize from 'sanitize-html';
import client from '../services/matrix';
import config from '../services/config';

export function transformImgSrc(mxcUrl: string, thumbnail: boolean): string {
    const parts = mxcUrl.replace('mxc://', '').split('/');
    const serverName = parts[0];
    const mediaId = parts.slice(1).join('/');
    if (thumbnail) {
        return `${config.matrix.homeserverUrl}/_matrix/client/v1/media/thumbnail/${serverName}/${mediaId}?width=64&height=64&method=scale&access_token=${client.getAccessToken()}`;
    } else {
        return `${config.matrix.homeserverUrl}/_matrix/client/v1/media/download/${serverName}/${mediaId}?access_token=${client.getAccessToken()}`;
    }
}

const allowedTags = sanitize.defaults.allowedTags.concat(['img', 'span', 'del', 'br']);

const allowedAttributes: Record<string, string[]> = {
    ...sanitize.defaults.allowedAttributes,
    img: ['src', 'alt', 'title', 'width', 'height'],
    span: ['data-mx-spoiler', 'data-mx-color', 'data-mx-bg-color', 'class'],
    a: ['href', 'name', 'target', 'rel'],
    code: ['class'],
    font: ['color', 'data-mx-color', 'data-mx-bg-color'],
    ol: ['start'],
};

export function sanitizeEventHtml(dirty: string): string {
    return sanitize(dirty, {
        allowedTags,
        allowedAttributes,
        allowedSchemes: ['https', 'http', 'mxc', 'mailto'],
        transformTags: {
            'img': (tagName, attribs) => {
                return {
                    tagName,
                    attribs: {
                        ...attribs,
                        src: attribs.src ? transformImgSrc(attribs.src, 'data-mx-emoticon' in attribs) : '',
                    },
                };
            },
        },
    });
}
