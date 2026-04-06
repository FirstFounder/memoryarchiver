// PM2 ecosystem file — CommonJS required even in ESM projects
//
// Synology first-time setup (run once as philander):
//   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
//   nvm install 22 && nvm use 22
//   npm install -g pm2
//   pm2 startup   # follow the printed command to register pm2 with the init system
//
// Deploy (after git pull):
//   ./deploy.sh
//
// Logs:
//   pm2 logs memoryarchiver

const APP_ROOT = '/var/services/homes/philander/memoryarchiver';

module.exports = {
  apps: [
    {
      name: 'memoryarchiver',
      script: `${APP_ROOT}/backend/src/server.js`,
      cwd: `${APP_ROOT}/backend`,
      env_file: `${APP_ROOT}/.env`,
      interpreter: 'node',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: `${APP_ROOT}/logs/out.log`,
      error_file: `${APP_ROOT}/logs/error.log`,
      merge_logs: true,
    },
  ],
};
