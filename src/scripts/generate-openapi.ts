/**
 * Script to generate openapi.json from the Fastify app's route schemas.
 * Run via: npm run generate:openapi
 */
import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifyCors from "@fastify/cors";
import { metersRoutes } from "../api/routes/meters.js";
import { transformersRoutes } from "../api/routes/transformers.js";
import { healthRoutes } from "../api/routes/health.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

async function generateOpenApi() {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors);
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Urja Meter Ops API",
        description:
          "A clean, documented REST API over the legacy Urja Meter Ops portal. " +
          "Provides programmatic access to smart meter data, distribution transformer info, " +
          "and energy consumption readings.",
        version: "1.0.0",
      },
      servers: [
        { url: "http://localhost:3000", description: "Local development server" },
      ],
      tags: [
        { name: "Meters", description: "Smart meter data" },
        { name: "Transformers", description: "Distribution transformer data" },
        { name: "System", description: "Health and admin endpoints" },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "X-API-Key",
            in: "header",
          },
        },
      },
      security: [{ apiKey: [] }],
    },
  });

  await app.register(metersRoutes);
  await app.register(transformersRoutes);
  await app.register(healthRoutes);

  await app.ready();

  const spec = app.swagger();
  const outputPath = resolve(process.cwd(), "openapi.json");
  writeFileSync(outputPath, JSON.stringify(spec, null, 2));
  console.log(`✅ OpenAPI spec written to ${outputPath}`);

  await app.close();
}

generateOpenApi().catch((err) => {
  console.error("Failed to generate OpenAPI spec:", err);
  process.exit(1);
});
