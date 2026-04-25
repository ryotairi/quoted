import { Image } from "@napi-rs/canvas";

export type TextStyle = {
    bold: boolean;
    italic: boolean;
    code: boolean;
    strike: boolean;
    underline: boolean;
    blockquote: boolean;
    pre: boolean;
    spoiler: boolean;
    size: number;
    color: string | null;
    codeLang: string | null;
};

export type ImageToken = {
    type: 'image';
    src: string;
    alt: string;
    w: number;
    h: number;
    imageObj?: Image;
};

export type Token =
    | { type: 'text', text: string, style: TextStyle }
    | ImageToken
    | { type: 'newline' };

export type LineItem =
    | { type: 'text', text: string, style: TextStyle, x: number, w: number }
    | { type: 'image', token: ImageToken, x: number, w: number, h: number };

export type Line = { 
    width: number, 
    height: number, 
    isBlockquote: boolean, 
    inPre?: boolean, 
    preHeader?: boolean, 
    codeLang?: string | null, 
    items: LineItem[] 
};

export class MeasureOracle {
    private cache = new Map<string, number>();
    private ctx: any;

    constructor(ctx: any) {
        this.ctx = ctx;
    }

    measure(text: string, font: string): number {
        const key = `${font}|${text}`;
        let w = this.cache.get(key);
        if (w !== undefined) return w;
        this.ctx.font = font;
        w = this.ctx.measureText(text).width;
        this.cache.set(key, w);
        return w;
    }
}

function decodeHtml(html: string) {
    return html.replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"')
               .replace(/&#39;/g, "'");
}

export function parseHtml(html: string): Token[] {
    const tokens: Token[] = [];
    const regex = /(<[^>]+>)|([^<]+)/g;
    let match;

    let bold = 0, italic = 0, code = 0, strike = 0, underline = 0, blockquote = 0, pre = 0;
    const colorStack: string[] = [];
    let spoiler = 0;
    const spoilerStack: boolean[] = [];
    const sizeStack: number[] = [];
    const codeLangStack: (string | null)[] = [];
    
    // Lists state
    const listStack: { type: 'ul' | 'ol', count: number }[] = [];

    while ((match = regex.exec(html)) !== null) {
        if (match[1]) {
            const tagFull = match[1];
            const isClosing = tagFull.startsWith('</');
            const tagMatch = tagFull.match(/<\/?([a-zA-Z0-9]+)/);
            if (!tagMatch) continue;
            const tagName = tagMatch[1].toLowerCase();

            if (isClosing) {
                if (tagName === 'b' || tagName === 'strong') bold = Math.max(0, bold - 1);
                if (tagName === 'i' || tagName === 'em') italic = Math.max(0, italic - 1);
                if (tagName === 'code') { code = Math.max(0, code - 1); codeLangStack.pop(); }
                if (tagName === 'pre') pre = Math.max(0, pre - 1);
                if (tagName === 's' || tagName === 'del') strike = Math.max(0, strike - 1);
                if (tagName === 'u') underline = Math.max(0, underline - 1);
                if (tagName === 'blockquote') blockquote = Math.max(0, blockquote - 1);
                if (tagName === 'font') colorStack.pop();
                if (tagName === 'span') {
                    colorStack.pop();
                    const wasSpoiler = spoilerStack.pop();
                    if (wasSpoiler) spoiler = Math.max(0, spoiler - 1);
                }
                if (tagName.match(/^h[1-6]$/)) { bold = Math.max(0, bold - 1); sizeStack.pop(); }
                if (tagName === 'ul' || tagName === 'ol') listStack.pop();
                
                if (['p', 'blockquote', 'li', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'].includes(tagName)) {
                    if (tokens.length > 0 && tokens[tokens.length - 1].type !== 'newline') {
                        tokens.push({ type: 'newline' });
                    }
                }
            } else {
                if (tagName === 'b' || tagName === 'strong') bold++;
                if (tagName === 'i' || tagName === 'em') italic++;
                if (tagName === 'pre') pre++;
                if (tagName === 's' || tagName === 'del') strike++;
                if (tagName === 'u') underline++;
                if (tagName === 'blockquote') blockquote++;
                if (tagName === 'br') tokens.push({ type: 'newline' });
                
                if (tagName === 'code') {
                    code++;
                    const classMatch = tagFull.match(/class=["'](.*?)["']/);
                    let lang = null;
                    if (classMatch) {
                        const m = classMatch[1].match(/language-([^ "]+)/);
                        if (m) lang = m[1];
                    }
                    codeLangStack.push(lang);
                }

                if (tagName.match(/^h[1-6]$/)) {
                    bold++;
                    if (tagName === 'h1') sizeStack.push(24);
                    else if (tagName === 'h2') sizeStack.push(20);
                    else if (tagName === 'h3') sizeStack.push(18);
                    else sizeStack.push(16);
                }

                if (tagName === 'ul') listStack.push({ type: 'ul', count: 0 });
                if (tagName === 'ol') listStack.push({ type: 'ol', count: 1 });
                if (tagName === 'li') {
                    if (tokens.length > 0 && tokens[tokens.length - 1].type !== 'newline') tokens.push({ type: 'newline' });
                    const list = listStack[listStack.length - 1];
                    let prefix = '• ';
                    if (list && list.type === 'ol') {
                        prefix = `${list.count}. `;
                        list.count++;
                    }
                    tokens.push({ type: 'text', text: "  " + prefix, style: {
                        bold: bold > 0, italic: italic > 0, code: code > 0, pre: pre > 0,
                        strike: strike > 0, underline: underline > 0, blockquote: blockquote > 0, spoiler: false,
                        size: sizeStack[sizeStack.length - 1] || 14, color: colorStack[colorStack.length - 1] || null, codeLang: null
                    }});
                }

                if (tagName === 'img') {
                    const srcMatch = tagFull.match(/src=["'](.*?)["']/);
                    const altMatch = tagFull.match(/alt=["'](.*?)["']/);
                    const wMatch = tagFull.match(/width=["'](\d+)["']/);
                    const hMatch = tagFull.match(/height=["'](\d+)["']/);
                    if (srcMatch) {
                        tokens.push({
                            type: 'image',
                            src: decodeHtml(srcMatch[1]),
                            alt: altMatch ? decodeHtml(altMatch[1]) : '',
                            w: wMatch ? parseInt(wMatch[1], 10) : 24,
                            h: hMatch ? parseInt(hMatch[1], 10) : 24,
                        });
                    }
                }
                
                if (tagName === 'font') {
                    const colorMatch = tagFull.match(/color=["'](.*?)["']/);
                    colorStack.push(colorMatch ? colorMatch[1] : colorStack[colorStack.length - 1] || null);
                }
                if (tagName === 'span') {
                    const isSpoiler = tagFull.includes('data-mx-spoiler');
                    if (isSpoiler) spoiler++;
                    spoilerStack.push(isSpoiler);

                    const colorMatch = tagFull.match(/data-mx-color=["'](.*?)["']/);
                    const classMatch = tagFull.match(/class=["'](.*?)["']/);
                    let colorToPush = colorStack[colorStack.length - 1] || null;
                    if (colorMatch) colorToPush = colorMatch[1];
                    else if (classMatch) {
                        const cls = classMatch[1];
                        if (cls.includes('hljs-keyword') || cls.includes('hljs-built_in') || cls.includes('hljs-literal') || cls.includes('hljs-type')) colorToPush = '#ff7b72'; // pink
                        else if (cls.includes('hljs-string')) colorToPush = '#a5d6ff'; // light blue
                        else if (cls.includes('hljs-number')) colorToPush = '#79c0ff'; // blue
                        else if (cls.includes('hljs-comment')) colorToPush = '#8b949e'; // gray
                        else if (cls.includes('hljs-function') || cls.includes('hljs-title')) colorToPush = '#d2a8ff'; // purple
                        else if (cls.includes('hljs-variable') || cls.includes('hljs-params') || cls.includes('hljs-attr') || cls.includes('hljs-property')) colorToPush = '#ffa657'; // orange
                    }
                    colorStack.push(colorToPush);
                }
                
                if (['p', 'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'].includes(tagName)) {
                    if (tokens.length > 0 && tokens[tokens.length - 1].type !== 'newline') {
                        tokens.push({ type: 'newline' });
                    }
                }
            }
        } else if (match[2]) {
            const text = decodeHtml(match[2]);
            if (text) {
                const currentStyle: TextStyle = {
                    bold: bold > 0, italic: italic > 0, code: code > 0, pre: pre > 0,
                    strike: strike > 0, underline: underline > 0, blockquote: blockquote > 0, spoiler: spoiler > 0,
                    size: sizeStack[sizeStack.length - 1] || 14, color: colorStack[colorStack.length - 1] || null,
                    codeLang: codeLangStack[codeLangStack.length - 1] || null
                };

                // If preformatted, preserve newlines and spaces as individual tokens
                if (pre > 0) {
                    const parts = text.split('\n');
                    for (let i = 0; i < parts.length; i++) {
                        if (parts[i]) {
                            tokens.push({ type: 'text', text: parts[i], style: currentStyle });
                        }
                        if (i < parts.length - 1) tokens.push({ type: 'newline' });
                    }
                } else {
                    tokens.push({ type: 'text', text, style: currentStyle });
                }
            }
        }
    }
    return tokens;
}

function getFont(style: TextStyle) {
    let font = `${style.size || 14}px `;
    if (style.code || style.pre) font += "monospace";
    else font += "sans-serif";
    
    if (style.bold && style.italic) font = "italic bold " + font;
    else if (style.bold) font = "bold " + font;
    else if (style.italic) font = "italic " + font;
    
    return font;
}

type Segment =
    | { type: 'word', text: string, font: string, style: TextStyle, width: number }
    | { type: 'whitespace', text: string, font: string, style: TextStyle, width: number }
    | { type: 'image', token: ImageToken, style: TextStyle, width: number, height: number }
    | { type: 'newline', style?: TextStyle };

export function layoutRichText(oracle: MeasureOracle, tokens: Token[], maxWidth: number): Line[] {
    const segments: Segment[] = [];
    
    let lastStyle: TextStyle | undefined;

    for (const token of tokens) {
        if (token.type === 'newline') {
            segments.push({ type: 'newline', style: lastStyle });
        } else if (token.type === 'image') {
            segments.push({ type: 'image', token, style: lastStyle || { bold: false, italic: false, code: false, pre: false, strike: false, underline: false, blockquote: false, spoiler: false, size: 14, color: null, codeLang: null }, width: token.w, height: token.h });
        } else if (token.type === 'text') {
            lastStyle = token.style;
            const font = getFont(token.style);
            const chunks = token.text.split(/([ \t]+)/);
            for (const chunk of chunks) {
                if (!chunk) continue;
                const isSpace = /^[ \t]+$/.test(chunk);
                const width = oracle.measure(chunk, font);
                segments.push({
                    type: isSpace ? 'whitespace' : 'word',
                    text: chunk,
                    font,
                    style: token.style,
                    width
                });
            }
        }
    }

    const lines: Line[] = [];
    let inPre = false;
    let currentLine: Line = { width: 0, height: 20, isBlockquote: false, inPre, items: [] };

    const pushLine = () => {
        if (currentLine.items.length > 0 || currentLine.inPre || lines.length === 0) {
            const indent = currentLine.isBlockquote ? 12 : 0;
            const preIndent = currentLine.inPre ? 6 : 0;
            const rightPadding = currentLine.inPre ? 16 : 0;
            if (currentLine.items.length > 0 || currentLine.inPre) {
                currentLine.width += indent + preIndent + rightPadding;
            }
            lines.push(currentLine);
        }
        currentLine = { width: 0, height: 20, isBlockquote: false, inPre, items: [] };
    };

    for (const seg of segments) {
        const isPre = seg.style?.pre || false;

        // Transition INTO <pre> block
        if (isPre && !inPre) {
            if (currentLine.items.length > 0) pushLine();
            inPre = true;
            currentLine.inPre = true;
            // Inject header spacer
            lines.push({ 
                width: 0, 
                height: 38, // 32px header + padding
                isBlockquote: seg.style?.blockquote || false, 
                inPre: true,
                preHeader: true, 
                codeLang: seg.style?.codeLang,
                items: [] 
            });
        } 
        // Transition OUT OF <pre> block
        else if (!isPre && inPre) {
            if (currentLine.items.length > 0) pushLine();
            inPre = false;
            currentLine.inPre = false;
            // Inject bottom padding
            lines.push({ width: 0, height: 12, isBlockquote: seg.style?.blockquote || false, inPre: true, items: [] });
        }

        if (seg.type === 'newline') {
            pushLine();
            if (seg.style && seg.style.blockquote) currentLine.isBlockquote = true;
            if (seg.style && !inPre) currentLine.height = Math.max(currentLine.height, seg.style.size * 1.4);
            if (inPre) currentLine.height = 20; // fixed line height for code
            continue;
        }

        const isBlock = seg.style?.blockquote;
        currentLine.isBlockquote = currentLine.isBlockquote || isBlock;
        if (seg.style && !inPre) {
            currentLine.height = Math.max(currentLine.height, seg.style.size * 1.4);
        }
        
        const indent = currentLine.isBlockquote ? 12 : 0;
        const preIndent = inPre ? 6 : 0;
        const totalIndent = indent + preIndent;
        const rightPadding = inPre ? 16 : 0;
        const effectiveMaxWidth = maxWidth - totalIndent - rightPadding;

        if (seg.type === 'image') {
            if (currentLine.width + seg.width > effectiveMaxWidth && currentLine.items.length > 0) {
                pushLine();
                currentLine.isBlockquote = isBlock;
                if (seg.style && !inPre) currentLine.height = Math.max(currentLine.height, seg.style.size * 1.4);
            }
            currentLine.items.push({ type: 'image', token: seg.token, x: currentLine.width + totalIndent, w: seg.width, h: seg.height });
            currentLine.width += seg.width;
            currentLine.height = Math.max(currentLine.height, seg.height);
            continue;
        }

        if (currentLine.width + seg.width <= effectiveMaxWidth) {
            currentLine.items.push({ type: 'text', text: seg.text, style: seg.style, x: currentLine.width + totalIndent, w: seg.width });
            currentLine.width += seg.width;
        } else {
            // Preserve whitespace overflowing in <pre>
            if (seg.type === 'whitespace' && !isPre) continue;

            if (seg.width <= effectiveMaxWidth && currentLine.items.length > 0) {
                pushLine();
                currentLine.isBlockquote = isBlock;
                if (seg.style && !inPre) currentLine.height = Math.max(currentLine.height, seg.style.size * 1.4);
            }

            if (seg.width > effectiveMaxWidth || currentLine.width + seg.width > effectiveMaxWidth) {
                let currentPart = '';
                let partW = 0;
                
                for (const char of seg.text) {
                    const testPart = currentPart + char;
                    const testW = oracle.measure(testPart, seg.font);
                    
                    if (currentLine.width + testW > effectiveMaxWidth) {
                        if (currentPart.length > 0) {
                            currentLine.items.push({ type: 'text', text: currentPart, style: seg.style, x: currentLine.width + totalIndent, w: partW });
                            currentLine.width += partW;
                        }
                        pushLine();
                        currentLine.isBlockquote = isBlock;
                        if (seg.style && !inPre) currentLine.height = Math.max(currentLine.height, seg.style.size * 1.4);
                        
                        currentPart = char;
                        partW = oracle.measure(char, seg.font);
                    } else {
                        currentPart = testPart;
                        partW = testW;
                    }
                }
                if (currentPart.length > 0) {
                    currentLine.items.push({ type: 'text', text: currentPart, style: seg.style, x: currentLine.width + totalIndent, w: partW });
                    currentLine.width += partW;
                }
            } else {
                currentLine.items.push({ type: 'text', text: seg.text, style: seg.style, x: currentLine.width + totalIndent, w: seg.width });
                currentLine.width += seg.width;
            }
        }
    }
    
    if (inPre) {
        if (currentLine.items.length > 0 || currentLine.inPre) pushLine();
        lines.push({ width: 0, height: 12, isBlockquote: currentLine.isBlockquote, inPre: true, items: [] });
    } else if (currentLine.items.length > 0 || lines.length === 0) {
        pushLine();
    }

    return lines;
}

export function drawRichText(ctx: any, lines: Line[], startX: number, startY: number, contentWidth: number, defaultColor: string) {
    let cursorY = startY;

    // --- Pass 1: Draw backgrounds for <pre> blocks ---
    let preStartY = -1;
    let currentPreLang: string | null | undefined = null;
    let blockquoteOffset = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.inPre && preStartY === -1) {
            preStartY = cursorY;
            currentPreLang = line.codeLang;
            blockquoteOffset = line.isBlockquote ? 12 : 0;
        }

        if (!line.inPre && preStartY !== -1) {
            drawCodeBg(ctx, startX + blockquoteOffset, preStartY, contentWidth - blockquoteOffset, cursorY - preStartY, currentPreLang);
            preStartY = -1;
        }
        
        cursorY += line.height;
    }
    if (preStartY !== -1) {
        drawCodeBg(ctx, startX + blockquoteOffset, preStartY, contentWidth - blockquoteOffset, cursorY - preStartY, currentPreLang);
    }

    // --- Pass 2: Draw text and inline styles ---
    cursorY = startY;
    for (const line of lines) {
        const textY = cursorY + (line.height / 2) + 5;

        // Draw Blockquote Border
        if (line.isBlockquote) {
            ctx.fillStyle = "#4a4a59"; 
            ctx.beginPath();
            ctx.roundRect(startX, cursorY + 2, 3, line.height - 4, 2);
            ctx.fill();
        }

        for (const item of line.items) {
            if (item.type === 'image') {
                if (item.token.imageObj) {
                    const imgY = cursorY + (line.height - item.h) / 2;
                    ctx.drawImage(item.token.imageObj, startX + item.x, imgY, item.w, item.h);
                }
            } else if (item.type === 'text') {
                ctx.font = getFont(item.style);
                
                let fillStyle = item.style.color || defaultColor;
                if (line.isBlockquote && !item.style.color) {
                    fillStyle = "#aaaaaa";
                }
                
                if (item.style.spoiler) {
                    ctx.fillStyle = "#222222";
                    ctx.beginPath();
                    ctx.roundRect(startX + item.x, cursorY + 2, item.w, line.height - 4, 4);
                    ctx.fill();
                } else {
                    ctx.fillStyle = fillStyle;
                    
                    // Inline code background (only if NOT in a <pre> block!)
                    if (item.style.code && !item.style.pre) {
                        ctx.fillStyle = "rgba(100, 100, 100, 0.4)";
                        ctx.fillRect(startX + item.x, textY - item.style.size, item.w, line.height);
                        ctx.fillStyle = fillStyle;
                    }
                    
                    ctx.fillText(item.text, startX + item.x, textY);

                    if (item.style.underline || item.style.strike) {
                        ctx.beginPath();
                        ctx.strokeStyle = ctx.fillStyle;
                        ctx.lineWidth = 1;
                        if (item.style.underline) {
                            ctx.moveTo(startX + item.x, textY + 2);
                            ctx.lineTo(startX + item.x + item.w, textY + 2);
                        }
                        if (item.style.strike) {
                            ctx.moveTo(startX + item.x, textY - (item.style.size * 0.3));
                            ctx.lineTo(startX + item.x + item.w, textY - (item.style.size * 0.3));
                        }
                        ctx.stroke();
                    }
                }
            }
        }
        cursorY += line.height;
    }
    return cursorY;
}

function drawCodeBg(ctx: any, x: number, y: number, w: number, h: number, lang: string | null | undefined) {
    // Main dark body background
    ctx.fillStyle = "#11111b"; 
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();

    // Top Header background (matches Discord/macOS style)
    ctx.fillStyle = "#313244"; 
    ctx.beginPath();
    ctx.roundRect(x, y, w, 32, [8, 8, 0, 0]);
    ctx.fill();

    // Red, Yellow, Green UI circles
    ctx.fillStyle = "#ff5f56"; ctx.beginPath(); ctx.arc(x + 16, y + 16, 5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = "#ffbd2e"; ctx.beginPath(); ctx.arc(x + 32, y + 16, 5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = "#27c93f"; ctx.beginPath(); ctx.arc(x + 48, y + 16, 5, 0, Math.PI*2); ctx.fill();

    if (lang) {
        ctx.fillStyle = "#a6adc8";
        ctx.font = "12px sans-serif";
        ctx.fillText(lang.toLowerCase(), x + 64, y + 20); 
    }
}