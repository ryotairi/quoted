import { loadImage, Image } from '@napi-rs/canvas';

export async function loadCanvasImage(url: string): Promise<Image | null> {
    try {
        return await loadImage(url);
    } catch (e) {
        console.error(`Failed to load image from ${url}:`, e);
        return null;
    }
}

export function wrapText(
    ctx: any,
    text: string,
    maxWidth: number
): string[] {
    const lines: string[] = [];
    const paragraphs = text.split('\n');

    for (const paragraph of paragraphs) {
        if (paragraph.length === 0) {
            lines.push('');
            continue;
        }

        let currentLine = '';
        const words = paragraph.split(' ');

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const testLine = currentLine.length === 0 ? word : currentLine + ' ' + word;
            const metrics = ctx.measureText(testLine);

            if (metrics.width > maxWidth) {
                if (currentLine.length === 0) {
                    let currentWordPart = '';
                    for (const char of word) {
                        const testPart = currentWordPart + char;
                        if (ctx.measureText(testPart).width > maxWidth) {
                            lines.push(currentWordPart);
                            currentWordPart = char;
                        } else {
                            currentWordPart = testPart;
                        }
                    }
                    currentLine = currentWordPart;
                } else {
                    lines.push(currentLine);
                    currentLine = word;
                }
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) {
            lines.push(currentLine);
        }
    }
    return lines;
}

export function fillRoundRect(ctx: any, x: number, y: number, width: number, height: number, radius: number | {tl: number, tr: number, br: number, bl: number}) {
    if (typeof radius === 'number') {
        radius = {tl: radius, tr: radius, br: radius, bl: radius};
    }
    ctx.beginPath();
    ctx.moveTo(x + radius.tl, y);
    ctx.lineTo(x + width - radius.tr, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
    ctx.lineTo(x + width, y + height - radius.br);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
    ctx.lineTo(x + radius.bl, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
    ctx.lineTo(x, y + radius.tl);
    ctx.quadraticCurveTo(x, y, x + radius.tl, y);
    ctx.closePath();
    ctx.fill();
}
