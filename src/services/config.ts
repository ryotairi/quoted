import YAML from 'yaml';
import { existsSync, readFileSync } from 'fs';

type ConfigurationFile = {
    matrix: {
        homeserverUrl: string;
        accessToken: string;
        userId: string;
    };
    helpText: string;
    welcomeText: string;
    puppeteerNoSandbox: boolean;
};

function getConfig(): ConfigurationFile {
    if (!existsSync('config.yml')) {
        throw new Error('Configuration file does not exist!');
    }
    const configRaw = readFileSync('config.yml', 'utf-8');
    return YAML.parse(configRaw);
}

const config = getConfig();

export default config;