import { GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'fs';
import path from 'path';

let fontsRegistered = false;

export function registerFonts() {
    if (fontsRegistered) return;
    fontsRegistered = true;

    const fontDir = path.resolve(process.cwd(), 'fonts');

    const fonts = [
        { path: 'NotoSans-Regular.ttf', family: 'Noto Sans' },
        { path: 'NotoSans-Bold.ttf', family: 'Noto Sans' },
        { path: 'NotoSans-Italic.ttf', family: 'Noto Sans' },
        { path: 'NotoSans-BoldItalic.ttf', family: 'Noto Sans' },
        { path: 'NotoSansMono-Regular.ttf', family: 'Noto Sans Mono' },
        { path: 'NotoSansMono-Bold.ttf', family: 'Noto Sans Mono' },
        { path: 'NotoSansSymbols2-Regular.ttf', family: 'Noto Sans Symbols2' },
        { path: 'NotoSansMath-Regular.ttf', family: 'Noto Sans Math' },
        { path: 'NotoSansMath-Bold.ttf', family: 'Noto Sans Math' },
        { path: 'NotoSansMath-Italic.ttf', family: 'Noto Sans Math' },
        { path: 'NotoSansMath-BoldItalic.ttf', family: 'Noto Sans Math' },
        { path: 'NotoColorEmoji.ttf', family: 'Noto Color Emoji' },
        // Font Awesome 6 Free Solid – for file type icons
        { path: 'fa-solid-900.ttf', family: 'Font Awesome 6 Free' },
    ];

    for (const font of fonts) {
        const fullPath = path.join(fontDir, font.path);
        if (existsSync(fullPath)) {
            try {
                GlobalFonts.registerFromPath(fullPath, font.family);
            } catch (e) {
                console.warn(`Failed to register font ${fullPath}:`, e);
            }
        } else {
            console.warn(`Font not found: ${fullPath}`);
        }
    }

    // Load system CJK fonts (installed by fonts-noto-cjk on Debian/Ubuntu)
    const systemFontDirs = [
        '/usr/share/fonts/opentype/noto',   // Debian fonts-noto-cjk
        '/usr/share/fonts/truetype/noto',   // some distros
        '/usr/share/fonts/noto-cjk',
        '/usr/share/fonts/google-noto-cjk', // Fedora/CentOS
    ];
    for (const dir of systemFontDirs) {
        if (existsSync(dir)) {
            try {
                const loaded = (GlobalFonts as any).loadFontsFromDir?.(dir);
                if (loaded) break;
            } catch {}
        }
    }

    // Windows system CJK fallback
    if (process.platform === 'win32') {
        const winFonts = process.env.SystemRoot
            ? path.join(process.env.SystemRoot, 'Fonts')
            : 'C:\\Windows\\Fonts';
        const cjkWindowsFonts = [
            { file: 'msyh.ttf', family: 'Microsoft YaHei' },
            { file: 'msyhbd.ttc', family: 'Microsoft YaHei' },
            { file: 'simsun.ttc', family: 'SimSun' },
        ];
        for (const f of cjkWindowsFonts) {
            const p = path.join(winFonts, f.file);
            if (existsSync(p)) {
                try { GlobalFonts.registerFromPath(p, f.family); } catch {}
            }
        }
    }
}

// Noto Sans first for Latin/Cyrillic quality, then Math for Unicode math symbols,
// then CJK variants (loaded from system), then emoji
export const FONT_FAMILY_SANS = '"Noto Sans", "Noto Sans Math", "Noto Sans Symbols2", "Noto Color Emoji", "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK KR", "Microsoft YaHei", "SimSun", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
export const FONT_FAMILY_MONO = '"Noto Sans Mono", "Noto Sans Math", "Noto Sans", "Noto Color Emoji", monospace';
export const FONT_FAMILY_ICONS = '"Font Awesome 6 Free", "Noto Sans", sans-serif';
