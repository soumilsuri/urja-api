import { portalClient } from "../portal/client.js";
import { config } from "../config.js";
import {
  upsertMeter,
  upsertTransformer,
  upsertEnergyReading,
  saveDatabase,
  hasEnergyReadings,
  type MeterRow,
  type TransformerRow,
  type EnergyReadingRow,
} from "../db/database.js";
import type { PortalExportMeter, PortalEnergyReading } from "../portal/types.js";

/**
 * Orchestrates pulling data from the legacy portal into the local SQLite database.
 *
 * Design decisions:
 * - Meters sync via /portal/export (one call = all 403 meters with hierarchy + geo)
 * - DTs sync via paginated /portal/dts (2 calls for 40 DTs)
 * - Energy readings sync on-demand per meter (too expensive to bulk-sync 403 meters on startup)
 */

/** Sync all meters from the portal's bulk export endpoint */
export async function syncMeters(): Promise<number> {
  console.log("[sync] Syncing meters from /portal/export…");
  const now = new Date().toISOString();

  try {
    const exportData = await portalClient.getExport();
    const meters = exportData.data;

    for (const m of meters) {
      const row = exportMeterToRow(m, now);
      upsertMeter(row);
    }

    saveDatabase();
    console.log(`[sync] Synced ${meters.length} meters`);
    return meters.length;
  } catch (err) {
    console.error("[sync] Failed to sync meters:", err);
    throw err;
  }
}

/** Sync all distribution transformers (paginated, typically 2 pages) */
export async function syncTransformers(): Promise<number> {
  console.log("[sync] Syncing transformers from /portal/dts…");
  const now = new Date().toISOString();
  let total = 0;
  let page = 1;

  try {
    while (true) {
      const res = await portalClient.getTransformers(page);

      for (const dt of res.data) {
        const row: TransformerRow = {
          code: dt.code,
          name: dt.name,
          feeder_code: dt.feederCode,
          capacity_kva: dt.capacityKva,
          synced_at: now,
        };
        upsertTransformer(row);
      }

      total += res.data.length;

      if (total >= res.total || res.data.length === 0) break;
      page++;
    }

    saveDatabase();
    console.log(`[sync] Synced ${total} transformers`);
    return total;
  } catch (err) {
    console.error("[sync] Failed to sync transformers:", err);
    throw err;
  }
}

/**
 * Sync energy readings for a single meter.
 * Called on-demand when a consumer first requests energy data for a meter.
 * Skips if readings already exist (use force=true to re-sync).
 */
export async function syncEnergyForMeter(
  meterId: string,
  force: boolean = false
): Promise<number> {
  if (!force && hasEnergyReadings(meterId)) {
    return 0; // Already have data, skip
  }

  console.log(`[sync] Syncing energy readings for ${meterId}…`);
  const now = new Date().toISOString();

  try {
    const res = await portalClient.getMeterEnergy(meterId);
    const readings = res.data;

    for (const r of readings) {
      const row = energyReadingToRow(meterId, r, now);
      upsertEnergyReading(row);
    }

    saveDatabase();
    console.log(`[sync] Synced ${readings.length} energy readings for ${meterId}`);
    return readings.length;
  } catch (err) {
    console.error(`[sync] Failed to sync energy for ${meterId}:`, err);
    throw err;
  }
}

/** Run full sync: meters + transformers (not energy — that's on-demand) */
export async function syncAll(): Promise<{ meters: number; transformers: number }> {
  const meters = await syncMeters();
  const transformers = await syncTransformers();
  return { meters, transformers };
}

// ─── Data normalization helpers ─────────────────────────────────────────────

/** Convert a portal export meter to a database row, normalizing data */
function exportMeterToRow(m: PortalExportMeter, syncedAt: string): MeterRow {
  return {
    meter_id: m.meterId,
    serial_no: m.serialNo,
    make: m.make,
    phase_type: m.phaseType,
    install_status: m.installStatus,
    install_type: m.installType,
    build: m.build,
    dt_code: m.dtCode,
    // Hierarchy — blank strings become null
    zone_name: m.hierarchy?.zone?.name || null,
    zone_code: m.hierarchy?.zone?.code || null,
    circle_name: m.hierarchy?.circle?.name || null,
    circle_code: m.hierarchy?.circle?.code || null,
    division_name: m.hierarchy?.division?.name || null,
    division_code: m.hierarchy?.division?.code || null,
    subdivision_name: m.hierarchy?.subdivision?.name || null,
    subdivision_code: m.hierarchy?.subdivision?.code || null,
    substation_name: m.hierarchy?.substation?.name || null,
    substation_code: m.hierarchy?.substation?.code || null,
    feeder_name: m.hierarchy?.feeder?.name || null,
    feeder_code: m.hierarchy?.feeder?.code || null,
    dt_name: m.hierarchy?.dt?.name || null,
    dt_code_hierarchy: m.hierarchy?.dt?.code || null,
    // Geo — already numbers from export
    latitude: m.geo?.lat ?? null,
    longitude: m.geo?.lng ?? null,
    synced_at: syncedAt,
  };
}

/**
 * Convert a portal energy reading to a database row.
 * Normalizes:
 * - "DD/MM/YYYY HH:MM" → ISO 8601 with timezone offset
 * - String numbers → real numbers
 */
function energyReadingToRow(
  meterId: string,
  r: PortalEnergyReading,
  syncedAt: string
): EnergyReadingRow {
  return {
    meter_id: meterId,
    timestamp: parsePortalTimestamp(r.timestamp),
    kwh: parseFloat(r.kwh) || 0,
    kvah: parseFloat(r.kvah) || 0,
    volt_r: parseFloat(r.voltR) || 0,
    synced_at: syncedAt,
  };
}

/**
 * Parse portal timestamp "DD/MM/YYYY HH:MM" to ISO 8601 with IST offset.
 * Example: "23/06/2026 23:30" → "2026-06-23T23:30:00+05:30"
 */
function parsePortalTimestamp(ts: string): string {
  const offset = config.portalTimezoneOffset;
  const match = ts.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);

  if (!match) {
    // If we can't parse it, store it as-is with a note
    console.warn(`[sync] Unparseable timestamp: "${ts}"`);
    return ts;
  }

  const [, day, month, year, hour, minute] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:00${offset}`;
}
