import sdk from 'matrix-js-sdk';
import config from './config';

const client = sdk.createClient({
    baseUrl: config.matrix.homeserverUrl,
    accessToken: config.matrix.accessToken,
    userId: config.matrix.userId,
    timelineSupport: true,
});

export default client;
