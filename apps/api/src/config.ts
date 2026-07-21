import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

interface Config {
  port: number;
  nodeEnv: string;
  jwt: {
    secret: string;
    expiresIn: string;
  };
  github: {
    oauthClientId: string;
    oauthClientSecret: string;
    oauthCallbackUrl: string;
    appId: string;
    appSlug: string;
    privateKey: string;
    webhookSecret: string;
  };
  webUrl: string;
  apiUrl: string;
  encryptionKey: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

let cachedEnv: Record<string, string> = {};
let lastEnvMtime = 0;

function getLiveEnv(key: string, fallback: string): string {
  try {
    const envPath = path.resolve(__dirname, "../../../.env");
    if (fs.existsSync(envPath)) {
      const stat = fs.statSync(envPath);
      if (stat.mtimeMs !== lastEnvMtime) {
        const content = fs.readFileSync(envPath, "utf-8");
        cachedEnv = dotenv.parse(content);
        lastEnvMtime = stat.mtimeMs;
      }
      return cachedEnv[key] || fallback;
    }
  } catch (err) {
    console.error(`Error reading live env key ${key}:`, err);
  }
  return process.env[key] || fallback;
}

export const config: Config = {
  port: parseInt(optionalEnv("API_PORT", "3001"), 10),
  nodeEnv: optionalEnv("NODE_ENV", "development"),
  jwt: {
    secret: requireEnv("JWT_SECRET"),
    expiresIn: optionalEnv("JWT_EXPIRES_IN", "7d"),
  },
  github: {
    oauthClientId: optionalEnv("GITHUB_OAUTH_CLIENT_ID", ""),
    oauthClientSecret: optionalEnv("GITHUB_OAUTH_CLIENT_SECRET", ""),
    oauthCallbackUrl: optionalEnv(
      "GITHUB_OAUTH_CALLBACK_URL",
      "http://localhost:3001/auth/github/callback"
    ),
    appId: optionalEnv("GITHUB_APP_ID", ""),
    appSlug: optionalEnv("GITHUB_APP_SLUG", ""),
    privateKey: optionalEnv("GITHUB_APP_PRIVATE_KEY", ""),
    webhookSecret: optionalEnv("GITHUB_WEBHOOK_SECRET", ""),
  },
  get webUrl(): string {
    return getLiveEnv("WEB_URL", "http://localhost:5173");
  },
  apiUrl: optionalEnv("API_URL", "http://localhost:3001"),
  encryptionKey: optionalEnv("ENCRYPTION_KEY", "change-me-32-byte-hex-key-here!!"),
};

