import type { FastifyInstance } from "fastify";
import {
  getMeters,
  getMeterById,
  getEnergyReadings,
  type MeterFilters,
} from "../../db/database.js";
import { syncEnergyForMeter } from "../../sync/syncer.js";
import { formatMeterResponse, formatMeterSummary } from "../formatters.js";

// ─── JSON Schemas for OpenAPI generation ────────────────────────────────────

const hierarchyNodeSchema = {
  type: "object" as const,
  nullable: true,
  properties: {
    name: { type: "string" as const, nullable: true },
    code: { type: "string" as const },
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

const meterDetailSchema = {
  type: "object" as const,
  properties: {
    ...meterSummarySchema.properties,
    hierarchy: {
      type: "object" as const,
      properties: {
        zone: hierarchyNodeSchema,
        circle: hierarchyNodeSchema,
        division: hierarchyNodeSchema,
        subdivision: hierarchyNodeSchema,
        substation: hierarchyNodeSchema,
        feeder: hierarchyNodeSchema,
        dt: hierarchyNodeSchema,
      },
    },
  },
};

const energyReadingSchema = {
  type: "object" as const,
  properties: {
    timestamp: { type: "string" as const, format: "date-time" as const, description: "ISO 8601 timestamp with IST offset (+05:30)" },
    kwh: { type: "number" as const, description: "Cumulative kWh register reading" },
    kvah: { type: "number" as const, description: "Cumulative kVAh register reading" },
    voltR: { type: "number" as const, description: "Instantaneous R-phase voltage" },
  },
};

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

// ─── Route registration ─────────────────────────────────────────────────────

export async function metersRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/meters — Paginated, filterable meter list
   */
  app.get("/api/v1/meters", {
    schema: {
      summary: "List meters",
      description: "Paginated list of smart meters with optional filters. " +
        "Filters are combined with AND logic. Text search (q) matches meter ID and serial number.",
      tags: ["Meters"],
      querystring: {
        type: "object" as const,
        properties: {
          page: { type: "integer" as const, minimum: 1, default: 1, description: "Page number (1-indexed)" },
          pageSize: { type: "integer" as const, minimum: 1, maximum: 100, default: 20, description: "Results per page" },
          q: { type: "string" as const, description: "Search by meter ID or serial number (partial match)" },
          make: { type: "string" as const, enum: ["HPL", "Genus", "Secure", "Allied", "L&T"], description: "Filter by manufacturer" },
          phaseType: { type: "string" as const, enum: ["single", "three"], description: "Filter by phase type" },
          installStatus: { type: "string" as const, enum: ["Installed", "Faulty", "Decommissioned"], description: "Filter by install status" },
          installType: { type: "string" as const, enum: ["Whole Current", "CT Operated"], description: "Filter by install type" },
          build: { type: "string" as const, enum: ["legacy", "v2"], description: "Filter by hardware generation" },
          dtCode: { type: "string" as const, description: "Filter by distribution transformer code (e.g. DT-001)" },
          zoneCode: { type: "string" as const, description: "Filter by zone code (e.g. Z-01)" },
          circleCode: { type: "string" as const, description: "Filter by circle code" },
          divisionCode: { type: "string" as const, description: "Filter by division code" },
        },
      },
      response: {
        200: {
          type: "object" as const,
          properties: {
            data: { type: "array" as const, items: meterSummarySchema },
            total: { type: "integer" as const },
            page: { type: "integer" as const },
            pageSize: { type: "integer" as const },
          },
        },
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const query = request.query as MeterFilters & { page?: number; pageSize?: number };
      const { data, total } = getMeters(query);

      return {
        data: data.map(formatMeterSummary),
        total,
        page: query.page || 1,
        pageSize: query.pageSize || 20,
      };
    },
  });

  /**
   * GET /api/v1/meters/:meterId — Single meter detail with full hierarchy and geo
   */
  app.get("/api/v1/meters/:meterId", {
    schema: {
      summary: "Get meter detail",
      description: "Full meter record including network hierarchy and geo coordinates.",
      tags: ["Meters"],
      params: {
        type: "object" as const,
        properties: {
          meterId: { type: "string" as const, description: "Meter ID (e.g. J100000)" },
        },
        required: ["meterId"],
      },
      response: {
        200: {
          type: "object" as const,
          properties: {
            data: meterDetailSchema,
          },
        },
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { meterId } = request.params as { meterId: string };
      const meter = getMeterById(meterId);

      if (!meter) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: `Meter ${meterId} not found`,
          },
        });
      }

      return { data: formatMeterResponse(meter) };
    },
  });

  /**
   * GET /api/v1/meters/:meterId/energy — Energy readings time series
   *
   * On first request for a meter, triggers on-demand sync from the portal.
   * Subsequent requests are served from the local cache.
   */
  app.get("/api/v1/meters/:meterId/energy", {
    schema: {
      summary: "Get meter energy readings",
      description: "30-minute interval energy consumption data. Timestamps are ISO 8601 with IST offset. " +
        "kwh/kvah are cumulative register readings (not per-interval deltas). " +
        "First request for a meter triggers a sync from the portal (may take a moment).",
      tags: ["Meters"],
      params: {
        type: "object" as const,
        properties: {
          meterId: { type: "string" as const, description: "Meter ID (e.g. J100000)" },
        },
        required: ["meterId"],
      },
      querystring: {
        type: "object" as const,
        properties: {
          from: { type: "string" as const, format: "date-time" as const, description: "Start time filter (ISO 8601)" },
          to: { type: "string" as const, format: "date-time" as const, description: "End time filter (ISO 8601)" },
        },
      },
      response: {
        200: {
          type: "object" as const,
          properties: {
            data: { type: "array" as const, items: energyReadingSchema },
            meterId: { type: "string" as const },
            count: { type: "integer" as const },
          },
        },
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { meterId } = request.params as { meterId: string };
      const { from, to } = request.query as { from?: string; to?: string };

      // Check meter exists
      const meter = getMeterById(meterId);
      if (!meter) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: `Meter ${meterId} not found`,
          },
        });
      }

      // On-demand sync: fetch energy data from portal if we don't have it cached
      try {
        await syncEnergyForMeter(meterId);
      } catch (err) {
        console.error(`[api] Energy sync failed for ${meterId}:`, err);
        // Don't fail the request — serve whatever we have cached
      }

      const readings = getEnergyReadings(meterId, from, to);

      return {
        data: readings.map((r) => ({
          timestamp: r.timestamp,
          kwh: r.kwh,
          kvah: r.kvah,
          voltR: r.volt_r,
        })),
        meterId,
        count: readings.length,
      };
    },
  });
}
