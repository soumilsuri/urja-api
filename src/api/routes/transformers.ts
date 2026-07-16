import type { FastifyInstance } from "fastify";
import {
  getTransformers,
  getTransformerByCode,
  getMetersByDtCode,
} from "../../db/database.js";
import { formatMeterSummary } from "../formatters.js";

const errorSchema = {
  type: "object" as const,
  properties: {
    error: {
      type: "object" as const,
      properties: {
        code: { type: "string" as const },
        message: { type: "string" as const },
      },
    },
  },
};

const geoSchema = {
  type: "object" as const,
  nullable: true,
  properties: {
    latitude: { type: "number" as const },
    longitude: { type: "number" as const },
  },
};

const meterSummarySchema = {
  type: "object" as const,
  properties: {
    meterId: { type: "string" as const },
    serialNo: { type: "string" as const },
    make: { type: "string" as const },
    phaseType: { type: "string" as const },
    installStatus: { type: "string" as const },
    installType: { type: "string" as const },
    build: { type: "string" as const },
    dtCode: { type: "string" as const },
    geo: geoSchema,
    syncedAt: { type: "string" as const, format: "date-time" as const },
  },
};

const transformerSchema = {
  type: "object" as const,
  properties: {
    code: { type: "string" as const, description: "Transformer code (e.g. DT-001)" },
    name: { type: "string" as const, description: "Human-readable name (e.g. Malviya Nagar DT 1)" },
    feederCode: { type: "string" as const, description: "Feeder code this DT belongs to" },
    capacityKva: { type: "integer" as const, description: "Transformer capacity in kVA" },
    syncedAt: { type: "string" as const, format: "date-time" as const },
  },
};

export async function transformersRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/transformers — Paginated list of distribution transformers
   */
  app.get("/api/v1/transformers", {
    schema: {
      summary: "List transformers",
      description: "Paginated list of distribution transformers (DTs).",
      tags: ["Transformers"],
      querystring: {
        type: "object" as const,
        properties: {
          page: { type: "integer" as const, minimum: 1, default: 1 },
          pageSize: { type: "integer" as const, minimum: 1, maximum: 100, default: 20 },
        },
      },
      response: {
        200: {
          type: "object" as const,
          properties: {
            data: { type: "array" as const, items: transformerSchema },
            total: { type: "integer" as const },
            page: { type: "integer" as const },
            pageSize: { type: "integer" as const },
          },
        },
      },
    },
    handler: async (request) => {
      const { page = 1, pageSize = 20 } = request.query as { page?: number; pageSize?: number };
      const result = getTransformers(page, pageSize);

      return {
        data: result.data.map((dt) => ({
          code: dt.code,
          name: dt.name,
          feederCode: dt.feeder_code,
          capacityKva: dt.capacity_kva,
          syncedAt: dt.synced_at,
        })),
        total: result.total,
        page,
        pageSize,
      };
    },
  });

  /**
   * GET /api/v1/transformers/:code — Single transformer detail
   */
  app.get("/api/v1/transformers/:code", {
    schema: {
      summary: "Get transformer detail",
      description: "Single distribution transformer by code.",
      tags: ["Transformers"],
      params: {
        type: "object" as const,
        properties: {
          code: { type: "string" as const, description: "Transformer code (e.g. DT-001)" },
        },
        required: ["code"],
      },
      response: {
        200: {
          type: "object" as const,
          properties: {
            data: transformerSchema,
          },
        },
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { code } = request.params as { code: string };
      const dt = getTransformerByCode(code);

      if (!dt) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: `Transformer ${code} not found`,
          },
        });
      }

      return {
        data: {
          code: dt.code,
          name: dt.name,
          feederCode: dt.feeder_code,
          capacityKva: dt.capacity_kva,
          syncedAt: dt.synced_at,
        },
      };
    },
  });

  /**
   * GET /api/v1/transformers/:code/meters — Meters attached to a DT
   * This is a derived endpoint (not a native portal endpoint).
   */
  app.get("/api/v1/transformers/:code/meters", {
    schema: {
      summary: "List meters under a transformer",
      description: "All smart meters attached to a specific distribution transformer. " +
        "This is a derived endpoint — the portal doesn't have a direct equivalent.",
      tags: ["Transformers"],
      params: {
        type: "object" as const,
        properties: {
          code: { type: "string" as const },
        },
        required: ["code"],
      },
      response: {
        200: {
          type: "object" as const,
          properties: {
            data: { type: "array" as const, items: meterSummarySchema },
            total: { type: "integer" as const },
            transformerCode: { type: "string" as const },
          },
        },
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { code } = request.params as { code: string };

      // Verify the DT exists
      const dt = getTransformerByCode(code);
      if (!dt) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: `Transformer ${code} not found`,
          },
        });
      }

      const meters = getMetersByDtCode(code);
      return {
        data: meters.map(formatMeterSummary),
        total: meters.length,
        transformerCode: code,
      };
    },
  });
}
