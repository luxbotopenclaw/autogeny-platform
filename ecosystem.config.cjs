/**
 * PM2 ecosystem config for Autogeny Platform (Paperclip fork)
 * Port: 3100 — runs alongside existing Autogeny app (port 3001)
 *
 * Run: pm2 start ecosystem.config.cjs
 */
const path = require("path");
const fs = require("fs");

// Parse .env file manually (avoid requiring dotenv as a peer dep)
function parseEnvFile(envPath) {
  const envConfig = {};
  try {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      envConfig[key] = val;
    }
  } catch {
    // .env not found — rely on process environment
  }
  return envConfig;
}

const envPath = path.join(__dirname, ".env");
const envConfig = parseEnvFile(envPath);

// tsx loader path — same as Paperclip's Docker CMD:
// node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
const tsxLoaderPath = path.join(__dirname, "server/node_modules/tsx/dist/loader.mjs");

module.exports = {
  apps: [
    {
      name: "autogeny-platform",
      // Use tsx loader to resolve TypeScript workspace package imports at runtime
      // This matches the Paperclip Docker CMD exactly
      interpreter: "node",
      node_args: `--import ${tsxLoaderPath}`,
      script: path.join(__dirname, "server/dist/index.js"),
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PORT: "3100",
        SERVE_UI: "true",
        PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
        PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
        PAPERCLIP_PUBLIC_URL: "http://localhost:3100",
        PAPERCLIP_MIGRATION_PROMPT: "never",
        PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
        ...envConfig,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      error_file: "/tmp/autogeny-platform-error.log",
      out_file: "/tmp/autogeny-platform-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
