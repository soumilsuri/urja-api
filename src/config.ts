import { config as dotenvConfig } from "dotenv";
dotenvConfig();

// Enforce required environment variables in production-like settings.
// We throw a descriptive error if credentials are missing to avoid silent auth failures.
const portalUrl = process.env.PORTAL_URL || "https://urja-ops.flockenergy.tech";
const portalEmail = process.env.PORTAL_EMAIL;
const portalPassword = process.env.PORTAL_PASSWORD;
const apiKey = process.env.API_KEY;

if (!portalEmail || !portalPassword) {
  throw new Error(
    "Missing critical portal credentials. Make sure PORTAL_EMAIL and PORTAL_PASSWORD are set in your .env file."
  );
}

if (!apiKey) {
  throw new Error(
    "Missing API_KEY configuration. Make sure API_KEY is set in your .env file."
  );
}

export const config = {
  portal: {
    url: portalUrl,
    email: portalEmail,
    password: portalPassword,
  },
  api: {
    port: parseInt(process.env.PORT || "3000", 10),
    apiKey: apiKey,
  },
  db: {
    path: process.env.DB_PATH || (process.env.VERCEL ? "/tmp/urja.db" : "./data/urja.db"),
  },
  portalTimezoneOffset: process.env.PORTAL_TIMEZONE_OFFSET || "+05:30",
};
