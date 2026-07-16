import { buildApp } from "../src/server.js";
import { initDatabase } from "../src/db/database.js";
import { syncAll } from "../src/sync/syncer.js";

// Maintain a global Fastify application reference across serverless cold starts.
let appInstance: any = null;
let dbInitialized = false;

export default async function handler(req: any, res: any) {
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;

    // Trigger an initial sync on first load to populate the SQLite cache if empty
    try {
      await syncAll();
    } catch (e) {
      console.error("[vercel] Cold-start database sync failed:", e);
    }
  }

  if (!appInstance) {
    appInstance = await buildApp({ logger: false });
  }

  await appInstance.ready();
  appInstance.server.emit("request", req, res);
}
