import initSqlJs from "sql.js";
import type { Database, QueryExecResult } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

let db: Database;
let isInMemoryOnly = false;

// Resolve the absolute path to the sql.js wasm binary.
// This is critical on Vercel where the working directory may differ from
// where node_modules lives. We resolve it relative to this file's location.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const wasmPath = join(__dirname, "..", "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm");

/**
 * Initialize SQLite database (sql.js — pure JS, no native compilation).
 * Creates the schema if the database file doesn't exist yet.
 * Loads from disk if it does.
 */
export async function initDatabase(): Promise<void> {
  const SQL = await initSqlJs({
    // Tell sql.js exactly where to find its wasm file regardless of cwd
    locateFile: () => wasmPath,
  });

  try {
    const dbDir = dirname(config.db.path);

    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    if (existsSync(config.db.path)) {
      const buffer = readFileSync(config.db.path);
      db = new SQL.Database(buffer);
      console.log(`[db] Loaded existing database from ${config.db.path}`);
    } else {
      db = new SQL.Database();
      console.log(`[db] Created new database`);
    }
  } catch (err: any) {
    console.warn(`[db] Failed to initialize file-backed database (${err.message}). Falling back to pure in-memory storage.`);
    isInMemoryOnly = true;
    db = new SQL.Database();
  }

  createSchema();
  saveDatabase();
}

/** Persist the in-memory database to disk */
export function saveDatabase(): void {
  if (isInMemoryOnly) {
    return;
  }
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(config.db.path, buffer);
  } catch (err: any) {
    console.warn(`[db] Failed to save database to disk (${err.message}). Switching to pure in-memory mode.`);
    isInMemoryOnly = true;
  }
}

/** Create tables if they don't exist */
function createSchema(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS meters (
      meter_id         TEXT PRIMARY KEY,
      serial_no        TEXT,
      make             TEXT,
      phase_type       TEXT,
      install_status   TEXT,
      install_type     TEXT,
      build            TEXT,
      dt_code          TEXT,
      zone_name        TEXT,
      zone_code        TEXT,
      circle_name      TEXT,
      circle_code      TEXT,
      division_name    TEXT,
      division_code    TEXT,
      subdivision_name TEXT,
      subdivision_code TEXT,
      substation_name  TEXT,
      substation_code  TEXT,
      feeder_name      TEXT,
      feeder_code      TEXT,
      dt_name          TEXT,
      dt_code_hierarchy TEXT,
      latitude         REAL,
      longitude        REAL,
      synced_at        TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transformers (
      code          TEXT PRIMARY KEY,
      name          TEXT,
      feeder_code   TEXT,
      capacity_kva  INTEGER,
      synced_at     TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS energy_readings (
      meter_id   TEXT,
      timestamp  TEXT,
      kwh        REAL,
      kvah       REAL,
      volt_r     REAL,
      synced_at  TEXT,
      PRIMARY KEY (meter_id, timestamp)
    )
  `);

  // Indexes for common query patterns
  db.run(`CREATE INDEX IF NOT EXISTS idx_meters_dt_code ON meters(dt_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_meters_make ON meters(make)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_meters_install_status ON meters(install_status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_meters_zone_code ON meters(zone_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_energy_meter_id ON energy_readings(meter_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_energy_timestamp ON energy_readings(timestamp)`);
}

// ─── Meter queries ──────────────────────────────────────────────────────────

export interface MeterRow {
  meter_id: string;
  serial_no: string;
  make: string;
  phase_type: string;
  install_status: string;
  install_type: string;
  build: string;
  dt_code: string;
  zone_name: string | null;
  zone_code: string | null;
  circle_name: string | null;
  circle_code: string | null;
  division_name: string | null;
  division_code: string | null;
  subdivision_name: string | null;
  subdivision_code: string | null;
  substation_name: string | null;
  substation_code: string | null;
  feeder_name: string | null;
  feeder_code: string | null;
  dt_name: string | null;
  dt_code_hierarchy: string | null;
  latitude: number | null;
  longitude: number | null;
  synced_at: string;
}

export interface MeterFilters {
  q?: string;
  make?: string;
  phaseType?: string;
  installStatus?: string;
  installType?: string;
  build?: string;
  dtCode?: string;
  zoneCode?: string;
  circleCode?: string;
  divisionCode?: string;
  page?: number;
  pageSize?: number;
}

export function upsertMeter(meter: MeterRow): void {
  db.run(
    `INSERT OR REPLACE INTO meters (
      meter_id, serial_no, make, phase_type, install_status, install_type, build, dt_code,
      zone_name, zone_code, circle_name, circle_code, division_name, division_code,
      subdivision_name, subdivision_code, substation_name, substation_code,
      feeder_name, feeder_code, dt_name, dt_code_hierarchy,
      latitude, longitude, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meter.meter_id, meter.serial_no, meter.make, meter.phase_type,
      meter.install_status, meter.install_type, meter.build, meter.dt_code,
      meter.zone_name, meter.zone_code, meter.circle_name, meter.circle_code,
      meter.division_name, meter.division_code, meter.subdivision_name, meter.subdivision_code,
      meter.substation_name, meter.substation_code, meter.feeder_name, meter.feeder_code,
      meter.dt_name, meter.dt_code_hierarchy,
      meter.latitude, meter.longitude, meter.synced_at,
    ]
  );
}

export function getMeters(filters: MeterFilters = {}): { data: MeterRow[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.q) {
    where.push("(meter_id LIKE ? OR serial_no LIKE ?)");
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  if (filters.make) {
    where.push("make = ?");
    params.push(filters.make);
  }
  if (filters.phaseType) {
    where.push("phase_type = ?");
    params.push(filters.phaseType);
  }
  if (filters.installStatus) {
    where.push("install_status = ?");
    params.push(filters.installStatus);
  }
  if (filters.installType) {
    where.push("install_type = ?");
    params.push(filters.installType);
  }
  if (filters.build) {
    where.push("build = ?");
    params.push(filters.build);
  }
  if (filters.dtCode) {
    where.push("dt_code = ?");
    params.push(filters.dtCode);
  }
  if (filters.zoneCode) {
    where.push("zone_code = ?");
    params.push(filters.zoneCode);
  }
  if (filters.circleCode) {
    where.push("circle_code = ?");
    params.push(filters.circleCode);
  }
  if (filters.divisionCode) {
    where.push("division_code = ?");
    params.push(filters.divisionCode);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 20;
  const offset = (page - 1) * pageSize;

  // Get total count
  const countResult = db.exec(`SELECT COUNT(*) as count FROM meters ${whereClause}`, params);
  const total = countResult.length > 0 ? (countResult[0].values[0][0] as number) : 0;

  // Get paginated data
  const dataResult = db.exec(
    `SELECT * FROM meters ${whereClause} ORDER BY meter_id LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  const data = resultToObjects<MeterRow>(dataResult);

  return { data, total };
}

export function getMeterById(meterId: string): MeterRow | null {
  const result = db.exec("SELECT * FROM meters WHERE meter_id = ?", [meterId]);
  const rows = resultToObjects<MeterRow>(result);
  return rows[0] || null;
}

export function getMetersByDtCode(dtCode: string): MeterRow[] {
  const result = db.exec(
    "SELECT * FROM meters WHERE dt_code = ? ORDER BY meter_id",
    [dtCode]
  );
  return resultToObjects<MeterRow>(result);
}

export function getMeterCount(): number {
  const result = db.exec("SELECT COUNT(*) FROM meters");
  return result.length > 0 ? (result[0].values[0][0] as number) : 0;
}

// ─── Transformer queries ────────────────────────────────────────────────────

export interface TransformerRow {
  code: string;
  name: string;
  feeder_code: string;
  capacity_kva: number;
  synced_at: string;
}

export function upsertTransformer(dt: TransformerRow): void {
  db.run(
    `INSERT OR REPLACE INTO transformers (code, name, feeder_code, capacity_kva, synced_at)
     VALUES (?, ?, ?, ?, ?)`,
    [dt.code, dt.name, dt.feeder_code, dt.capacity_kva, dt.synced_at]
  );
}

export function getTransformers(
  page: number = 1,
  pageSize: number = 20
): { data: TransformerRow[]; total: number } {
  const countResult = db.exec("SELECT COUNT(*) FROM transformers");
  const total = countResult.length > 0 ? (countResult[0].values[0][0] as number) : 0;

  const offset = (page - 1) * pageSize;
  const result = db.exec(
    "SELECT * FROM transformers ORDER BY code LIMIT ? OFFSET ?",
    [pageSize, offset]
  );

  return { data: resultToObjects<TransformerRow>(result), total };
}

export function getTransformerByCode(code: string): TransformerRow | null {
  const result = db.exec("SELECT * FROM transformers WHERE code = ?", [code]);
  const rows = resultToObjects<TransformerRow>(result);
  return rows[0] || null;
}

export function getTransformerCount(): number {
  const result = db.exec("SELECT COUNT(*) FROM transformers");
  return result.length > 0 ? (result[0].values[0][0] as number) : 0;
}

// ─── Energy reading queries ─────────────────────────────────────────────────

export interface EnergyReadingRow {
  meter_id: string;
  timestamp: string; // ISO 8601
  kwh: number;
  kvah: number;
  volt_r: number;
  synced_at: string;
}

export function upsertEnergyReading(reading: EnergyReadingRow): void {
  db.run(
    `INSERT OR REPLACE INTO energy_readings (meter_id, timestamp, kwh, kvah, volt_r, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [reading.meter_id, reading.timestamp, reading.kwh, reading.kvah, reading.volt_r, reading.synced_at]
  );
}

export function getEnergyReadings(
  meterId: string,
  from?: string,
  to?: string
): EnergyReadingRow[] {
  const where = ["meter_id = ?"];
  const params: (string | number)[] = [meterId];

  if (from) {
    where.push("timestamp >= ?");
    params.push(from);
  }
  if (to) {
    where.push("timestamp <= ?");
    params.push(to);
  }

  const result = db.exec(
    `SELECT * FROM energy_readings WHERE ${where.join(" AND ")} ORDER BY timestamp`,
    params
  );

  return resultToObjects<EnergyReadingRow>(result);
}

export function hasEnergyReadings(meterId: string): boolean {
  const result = db.exec(
    "SELECT COUNT(*) FROM energy_readings WHERE meter_id = ?",
    [meterId]
  );
  return result.length > 0 && (result[0].values[0][0] as number) > 0;
}

export function getLastSyncTime(table: "meters" | "transformers" | "energy_readings"): string | null {
  const result = db.exec(`SELECT MAX(synced_at) FROM ${table}`);
  if (result.length === 0 || result[0].values[0][0] === null) return null;
  return result[0].values[0][0] as string;
}

// ─── Utility ────────────────────────────────────────────────────────────────

/** Convert sql.js exec result to array of typed objects */
function resultToObjects<T>(result: QueryExecResult[]): T[] {
  if (result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((row: (string | number | null | Uint8Array)[]) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj as T;
  });
}
