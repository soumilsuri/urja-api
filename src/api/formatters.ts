import type { MeterRow } from "../db/database.js";

/**
 * Format a meter row from the flat DB schema into the clean API response shape.
 * Groups hierarchy fields into a nested object, geo into its own field.
 */
export function formatMeterResponse(row: MeterRow) {
  return {
    meterId: row.meter_id,
    serialNo: row.serial_no,
    make: row.make,
    phaseType: row.phase_type,
    installStatus: row.install_status,
    installType: row.install_type,
    build: row.build,
    dtCode: row.dt_code,
    hierarchy: {
      zone: row.zone_code ? { name: row.zone_name, code: row.zone_code } : null,
      circle: row.circle_code ? { name: row.circle_name, code: row.circle_code } : null,
      division: row.division_code ? { name: row.division_name, code: row.division_code } : null,
      subdivision: row.subdivision_code ? { name: row.subdivision_name, code: row.subdivision_code } : null,
      substation: row.substation_code ? { name: row.substation_name, code: row.substation_code } : null,
      feeder: row.feeder_code ? { name: row.feeder_name, code: row.feeder_code } : null,
      dt: row.dt_code_hierarchy ? { name: row.dt_name, code: row.dt_code_hierarchy } : null,
    },
    geo: row.latitude != null && row.longitude != null
      ? { latitude: row.latitude, longitude: row.longitude }
      : null,
    syncedAt: row.synced_at,
  };
}

/**
 * Format a meter row as a summary (no hierarchy/geo) for list endpoints.
 */
export function formatMeterSummary(row: MeterRow) {
  return {
    meterId: row.meter_id,
    serialNo: row.serial_no,
    make: row.make,
    phaseType: row.phase_type,
    installStatus: row.install_status,
    installType: row.install_type,
    build: row.build,
    dtCode: row.dt_code,
    geo: row.latitude != null && row.longitude != null
      ? { latitude: row.latitude, longitude: row.longitude }
      : null,
    syncedAt: row.synced_at,
  };
}
