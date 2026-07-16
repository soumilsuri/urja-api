import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fastifyCors from "@fastify/cors";
import { config } from "./config.js";
import { initDatabase } from "./db/database.js";
import { syncAll } from "./sync/syncer.js";
import { authMiddleware } from "./api/middleware/auth.js";
import { metersRoutes } from "./api/routes/meters.js";
import { transformersRoutes } from "./api/routes/transformers.js";
import { healthRoutes } from "./api/routes/health.js";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds and configures the Fastify app instance.
 * Exposes a helper function so the same setup can be run locally (listen)
 * or inside serverless functions like Vercel (exported handler).
 */
export async function buildApp(opts = {}) {
  const app = Fastify(opts);

  // ─── Static files / Dashboard UI ───────────────────────────────────────
  await app.register(fastifyStatic, {
    root: join(process.cwd(), "public"),
  });

  app.get("/", async (request, reply) => {
    return reply.sendFile("index.html");
  });

  app.get("/dashboard", async (request, reply) => {
    return reply.sendFile("index.html");
  });

  // ─── CORS ──────────────────────────────────────────────────────────────
  await app.register(fastifyCors, { origin: true });

  // ─── Swagger / OpenAPI ─────────────────────────────────────────────────
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Urja Meter Ops API",
        description:
          "A clean, documented REST API over the legacy Urja Meter Ops portal. " +
          "Provides programmatic access to smart meter data, distribution transformer info, " +
          "and energy consumption readings that were previously only available via the portal's web UI.",
        version: "1.0.0",
        contact: {
          name: "Urja API",
        },
      },
      servers: [
        {
          url: `http://localhost:${config.api.port}`,
          description: "Local development server",
        },
      ],
      tags: [
        { name: "Meters", description: "Smart meter data - identity, hierarchy, geo, and energy consumption" },
        { name: "Transformers", description: "Distribution transformer (DT) data" },
        { name: "System", description: "Health checks and administrative operations" },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "X-API-Key",
            in: "header",
            description: "API key for authentication. Pass via the X-API-Key header.",
          },
        },
      },
      security: [{ apiKey: [] }],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // ─── Auth middleware (skip for health, docs, and dashboard UI) ─────────
  app.addHook("onRequest", async (request, reply) => {
    const publicPaths = [
      "/api/v1/health",
      "/docs",
      "/docs/",
      "/docs/json",
      "/dashboard",
      "/public"
    ];
    
    const isRoot = request.url === "/";
    const isPublic = isRoot || publicPaths.some((p) => request.url.startsWith(p));

    if (!isPublic && request.url.startsWith("/api/")) {
      await authMiddleware(request, reply);
    }
  });

  // ─── Register routes ──────────────────────────────────────────────────
  await app.register(metersRoutes);
  await app.register(transformersRoutes);
  await app.register(healthRoutes);

  // ─── Global error handler ─────────────────────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const statusCode = error.statusCode || 500;
    const code = statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";

    app.log.error(error);

    reply.status(statusCode).send({
      error: {
        code,
        message: error.message,
      },
    });
  });

  return app;
}

// ─── Self-start logic for local execution ──────────────────────────────────
async function main() {
  await initDatabase();

  const app = await buildApp({
    logger: {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      },
    },
  });

  try {
    await app.listen({ port: config.api.port, host: "0.0.0.0" });
    console.log(`\n🚀 Urja API running at http://localhost:${config.api.port}`);
    console.log(`💻 Web Dashboard at http://localhost:${config.api.port}/`);
    console.log(`📖 API docs at http://localhost:${config.api.port}/docs`);
    console.log(`📋 OpenAPI spec at http://localhost:${config.api.port}/docs/json\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Initial sync from portal on boot
  try {
    console.log("[startup] Starting initial data sync from portal…");
    const result = await syncAll();
    console.log(
      `[startup] Initial sync complete: ${result.meters} meters, ${result.transformers} transformers`
    );
  } catch (err) {
    console.error("[startup] Initial sync failed (service will serve cached data if available):", err);
  }
}

// Check if running this script directly
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("src/server.ts") ||
  process.argv[1].endsWith("src/server.js") ||
  process.argv[1].endsWith("server.ts") ||
  process.argv[1].endsWith("server.js")
);

if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
