// DEPRECATED — DO NOT USE WITH PM2
// Process management is handled by macOS LaunchAgents exclusively.
// See: ~/Library/LaunchAgents/com.nexus.nexusgram*.plist
// This file is kept as configuration reference only.
//
// Previously: pm2 start ecosystem.config.cjs

const NEXUSGRAM_DIR = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/PROJECT_MODULES/Mac_Mini_AI_Server/nexusgram';
const NODE_PATH = '/opt/homebrew/opt/node@22/bin/node';

// Shared environment (API keys, paths)
const sharedEnv = {
  HOME: '/Users/ashtron',
  NODE_ENV: 'production',
  PATH: '/opt/homebrew/opt/node@22/bin:/Users/ashtron/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
};

module.exports = {
  apps: [
    {
      name: 'nexusgram-master',
      script: 'dist/index.js',
      cwd: NEXUSGRAM_DIR,
      interpreter: NODE_PATH,
      env: {
        ...sharedEnv,
        NEXUSGRAM_ENV_PATH: `${NEXUSGRAM_DIR}/.env`,
      },
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '500M',
    },
    {
      name: 'nexusgram-family',
      script: 'dist/index.js',
      cwd: NEXUSGRAM_DIR,
      interpreter: NODE_PATH,
      env: {
        ...sharedEnv,
        NEXUSGRAM_ENV_PATH: `${NEXUSGRAM_DIR}/.env.family`,
      },
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '500M',
    },
    {
      name: 'nexusgram-mom',
      script: 'dist/index.js',
      cwd: NEXUSGRAM_DIR,
      interpreter: NODE_PATH,
      env: {
        ...sharedEnv,
        NEXUSGRAM_ENV_PATH: `${NEXUSGRAM_DIR}/.env.mom`,
      },
      max_restarts: 10,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '500M',
    },
  ],
};
