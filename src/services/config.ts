import YAML from 'yaml';
import { existsSync, readFileSync } from 'fs';
import { setLogLevel, LogLevel } from '../utils/logger';

type ConfigurationFile = {
    matrix: {
        homeserverUrl: string;
        accessToken: string;
        userId: string;
    };
    helpText: string;
    welcomeText: string;
    logLevel?: LogLevel;
    commandPrefix?: string;
    commands?: {
        quote?: string;
        help?: string;
    };
    render?: {
        animatedStickers?: boolean;
        transparentBackground?: boolean;
        transparentBubbles?: boolean;
        stickerMaxSize?: number;
        emojiSize?: number;
        maxFrames?: number;
        fps?: number;
        ffmpegPath?: string;
    };
};

function getConfig(): Required<ConfigurationFile> & { render: Required<NonNullable<ConfigurationFile['render']>> } {
    if (!existsSync('config.yml')) {
        throw new Error('Configuration file does not exist!');
    }
    const configRaw = readFileSync('config.yml', 'utf-8');
    const cfg = YAML.parse(configRaw) as ConfigurationFile;

    // Defaults
    const out: any = {
        ...cfg,
        logLevel: cfg.logLevel || 'info',
        commandPrefix: cfg.commandPrefix ?? '..',
        commands: {
            quote: cfg.commands?.quote ?? 'q',
            help: cfg.commands?.help ?? 'help',
        },
        render: {
            animatedStickers: cfg.render?.animatedStickers ?? true,
            transparentBackground: cfg.render?.transparentBackground ?? true,
            transparentBubbles: cfg.render?.transparentBubbles ?? false,
            stickerMaxSize: cfg.render?.stickerMaxSize ?? 512,
            emojiSize: cfg.render?.emojiSize ?? 22,
            maxFrames: cfg.render?.maxFrames ?? 60,
            fps: cfg.render?.fps ?? 20,
            ffmpegPath: cfg.render?.ffmpegPath ?? 'ffmpeg',
        },
    };

    setLogLevel(out.logLevel);
    return out;
}

const config = getConfig();

export default config;