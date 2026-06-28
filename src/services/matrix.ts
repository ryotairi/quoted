import sdk from 'matrix-js-sdk';
import { logger as sdkGlobalLogger } from 'matrix-js-sdk/lib/logger.js';
import config from './config';
import { createLogger } from '../utils/logger';

const log = createLogger('matrix');
const sdkLog = createLogger('sdk');
const debugEnabled = config.logLevel === 'debug';

// Route ALL matrix-js-sdk output through our logger in the unified format.
// The SDK uses two logging paths: the per-client `opts.logger` (HTTP requests)
// and a module-global `loglevel` logger (sync, push rules, capabilities, …).
// We wire up both. Verbose trace/debug is only surfaced when our logLevel=debug.
const route = (method: 'debug' | 'info' | 'warn' | 'error') => (...a: any[]) => {
    if ((method === 'debug') && !debugEnabled) return;
    sdkLog[method](...a);
};
const sdkLogger: any = {
    trace: route('debug'),
    debug: route('debug'),
    info: route('info'),
    warn: route('warn'),
    error: route('error'),
    getChild: () => sdkLogger,
};

// Override the global SDK logger's method factory so its internal log calls
// (which bypass opts.logger) are reformatted instead of dumped raw to console.
try {
    (sdkGlobalLogger as any).methodFactory = (methodName: string) => {
        const m = methodName === 'trace' ? 'debug' : (methodName as 'debug' | 'info' | 'warn' | 'error');
        return route(m in { debug: 1, info: 1, warn: 1, error: 1 } ? m : 'info');
    };
    (sdkGlobalLogger as any).setLevel(debugEnabled ? 'debug' : 'warn');
} catch { /* non-fatal */ }

const client = sdk.createClient({
    baseUrl: config.matrix.homeserverUrl,
    accessToken: config.matrix.accessToken,
    userId: config.matrix.userId,
    timelineSupport: true,
    logger: sdkLogger,
});

log.success(`client ready for ${config.matrix.userId} @ ${config.matrix.homeserverUrl}`);

export default client;
