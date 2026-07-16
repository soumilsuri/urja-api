// ─── Raw portal response types ───────────────────────────────────────────────
// These match the exact shapes returned by the legacy portal's /portal/* JSON
// endpoints. No normalization here — that happens in the sync layer.

/** Envelope for paginated portal responses */
export interface PortalPaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Envelope for single-item portal responses */
export interface PortalDataResponse<T> {
  data: T;
}

/** Meter as returned by /portal/meters/search */
export interface PortalMeterSummary {
  meterId: string;
  serialNo: string;
  make: string;
  phaseType: string;
  installStatus: string;
  dtCode: string;
}

/** Hierarchy node in export data */
export interface PortalHierarchyNode {
  name: string;
  code: string;
}

/** Full meter record as returned by /portal/export */
export interface PortalExportMeter {
  meterId: string;
  serialNo: string;
  make: string;
  phaseType: string;
  installStatus: string;
  installType: string;
  build: string;
  dtCode: string;
  hierarchy: {
    zone: PortalHierarchyNode;
    circle: PortalHierarchyNode;
    division: PortalHierarchyNode;
    subdivision: PortalHierarchyNode;
    substation: PortalHierarchyNode;
    feeder: PortalHierarchyNode;
    dt: PortalHierarchyNode;
  };
  geo: {
    lat: number;
    lng: number;
  };
}

/** Geo as returned by /portal/meters/{id}/geo (different shape from export!) */
export interface PortalMeterGeo {
  latitude: string;
  longitude: string;
}

/** Energy reading as returned by /portal/meters/{id}/energy */
export interface PortalEnergyReading {
  timestamp: string; // "DD/MM/YYYY HH:MM"
  kwh: string;       // cumulative, as string
  kvah: string;      // cumulative, as string
  voltR: string;     // instantaneous voltage, as string
}

/** Distribution transformer as returned by /portal/dts */
export interface PortalTransformer {
  code: string;
  name: string;
  feederCode: string;
  capacityKva: number;
}

/** Signing keys as returned by /portal/keys */
export interface PortalKeys {
  signingSecret: string;
}

/** SvelteKit form action login response */
export interface PortalLoginResponse {
  type: string;
  status: number;
  location: string;
}
