import type { FastifyInstance } from "fastify";
import { portalClient } from "../../portal/client.js";
import {
  getMeterCount,
  getTransformerCount,
  getLastSyncTime,
} from "../../db/database.js";
import { syncAll } from "../../sync/syncer.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/health — Service and upstream portal health
   *
   * No API key required — this is a public health check endpoint.
   */
  app.get("/api/v1/health", {
    schema: {
      summary: "Health check",
      description: "Service health including upstream portal reachability and local data freshness.",
      tags: ["System"],
      security: [], // No auth required
      response: {
        200: {
          type: "object" as const,
          properties: {
            status: { type: "string" as const },
            portal: {
              type: "object" as const,
              properties: {
                reachable: { type: "boolean" as const },
              },
            },
            database: {
              type: "object" as const,
              properties: {
                meters: { type: "integer" as const },
                transformers: { type: "integer" as const },
                lastMeterSync: { type: "string" as const, nullable: true },
                lastTransformerSync: { type: "string" as const, nullable: true },
              },
            },
          },
        },
      },
    },
    handler: async () => {
      const portalReachable = await portalClient.isReachable();

      return {
        status: "ok",
        portal: {
          reachable: portalReachable,
        },
        database: {
          meters: getMeterCount(),
          transformers: getTransformerCount(),
          lastMeterSync: getLastSyncTime("meters"),
          lastTransformerSync: getLastSyncTime("transformers"),
        },
      };
    },
  });

  /**
   * POST /api/v1/sync — Manually trigger a re-sync from the portal
   *
   * Requires API key. Useful for forcing a data refresh without restarting the service.
   */
  app.post("/api/v1/sync", {
    schema: {
      summary: "Trigger data sync",
      description: "Manually trigger a re-sync of meters and transformers from the legacy portal. " +
        "Energy readings are synced on-demand per meter and are not affected by this endpoint.",
      tags: ["System"],
      response: {
        200: {
          type: "object" as const,
          properties: {
            message: { type: "string" as const },
            synced: {
              type: "object" as const,
              properties: {
                meters: { type: "integer" as const },
                transformers: { type: "integer" as const },
              },
            },
          },
        },
      },
    },
    handler: async () => {
      const result = await syncAll();

      return {
        message: "Sync completed successfully",
        synced: result,
      };
    },
  });
}
