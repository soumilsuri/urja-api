# Urja Meter Ops API

A clean, documented REST API service that sits in front of the legacy **Urja Meter Ops** portal, providing programmatic access to smart meter data, distribution transformer information, and energy consumption readings.
The legacy portal is a human-facing web app with no API. This service acts as an **adapter layer**: it logs into the portal, pulls data through the portal's internal JSON endpoints, normalizes it, caches it locally in SQLite, and exposes it through a versioned REST API with proper pagination, filtering, and documentation.

## Quick start

```bash
# 1. Clone the repo
git clone https://github.com/<your-username>/urja-api.git
cd urja-api
# 2. Install dependencies
npm install
# 3. Configure (defaults work out of the box for the legacy portal)
cp .env.example .env
# Edit .env if needed - defaults point to the legacy portal
# 4. Run
npm run dev
```

The service starts on `http://localhost:3000`, syncs meters and transformers from the portal on startup (~2 seconds), and is ready to serve requests.

- **Web Dashboard:** http://localhost:3000/ (Sleek UI to monitor grid status, meters, and consumption)
- **API docs:** http://localhost:3000/docs (Swagger UI)
- **OpenAPI spec:** http://localhost:3000/docs/json (live) or `openapi.json` (file)

## Sample requests

```bash
# Health check (no API key required)
curl http://localhost:3000/api/v1/health
# List meters (paginated, with filtering)
curl -H "X-API-Key: urja-dev-key-2026" \
  "http://localhost:3000/api/v1/meters?make=HPL&installStatus=Installed&page=1&pageSize=5"
# Get a single meter (full hierarchy + geo)
curl -H "X-API-Key: urja-dev-key-2026" \
  http://localhost:3000/api/v1/meters/J100000
# Get energy readings for a meter (ISO 8601 timestamps, numeric values)
curl -H "X-API-Key: urja-dev-key-2026" \
  http://localhost:3000/api/v1/meters/J100000/energy
# List distribution transformers
curl -H "X-API-Key: urja-dev-key-2026" \
  http://localhost:3000/api/v1/transformers
# Get meters under a specific transformer
curl -H "X-API-Key: urja-dev-key-2026" \
  http://localhost:3000/api/v1/transformers/DT-001/meters
# Trigger manual data re-sync from portal
curl -X POST -H "X-API-Key: urja-dev-key-2026" \
  http://localhost:3000/api/v1/sync
```

## API endpoints

| Method | Path                                | Description                                                                                                                 | Auth    |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| `GET`  | `/api/v1/meters`                    | Paginated meter list with filters (`make`, `phaseType`, `installStatus`, `installType`, `build`, `dtCode`, `zoneCode`, `q`) | API key |
| `GET`  | `/api/v1/meters/:meterId`           | Single meter detail with full hierarchy and geo                                                                             | API key |
| `GET`  | `/api/v1/meters/:meterId/energy`    | Energy consumption time series (30-min intervals)                                                                           | API key |
| `GET`  | `/api/v1/transformers`              | Paginated transformer list                                                                                                  | API key |
| `GET`  | `/api/v1/transformers/:code`        | Single transformer detail                                                                                                   | API key |
| `GET`  | `/api/v1/transformers/:code/meters` | Meters under a transformer                                                                                                  | API key |
| `GET`  | `/api/v1/health`                    | Service + portal health                                                                                                     | Public  |
| `POST` | `/api/v1/sync`                      | Trigger manual re-sync                                                                                                      | API key |

All list endpoints return `{ data, total, page, pageSize }`. All errors return `{ error: { code, message } }`.
Authentication: pass your API key in the `X-API-Key` header. Default dev key: `urja-dev-key-2026`.

## Project structure

```
urja-api/
├── src/
│   ├── server.ts                 # Entry point: Fastify app, Swagger, startup sync
│   ├── config.ts                 # Environment-driven configuration
│   ├── portal/                   # Legacy portal communication layer
│   │   ├── client.ts             # HTTP client with session management
│   │   ├── signing.ts            # HMAC-SHA256 signature for /portal/export
│   │   └── types.ts              # Raw portal response type definitions
│   ├── db/
│   │   └── database.ts           # SQLite schema, queries, and persistence
│   ├── sync/
│   │   └── syncer.ts             # Data sync orchestrator (portal → local DB)
│   ├── api/
│   │   ├── formatters.ts         # DB rows → clean API response shapes
│   │   ├── middleware/
│   │   │   └── auth.ts           # API key validation
│   │   └── routes/
│   │       ├── meters.ts         # /api/v1/meters routes
│   │       ├── transformers.ts   # /api/v1/transformers routes
│   │       └── health.ts         # /api/v1/health + /api/v1/sync
│   ├── scripts/
│   │   └── generate-openapi.ts   # Static OpenAPI spec generator
│   └── types/
│       └── sql.js.d.ts           # Type declarations for sql.js
├── data/                         # SQLite database (gitignored, created on first run)
├── openapi.json                  # OpenAPI 3.x spec (auto-generated)
├── PROTOCOL.md                   # How the legacy portal actually works
├── APPROACH.md                   # Methodology, decisions, trade-offs
├── LEGACY_SYSTEM_ANALYSIS.md     # Deep technical analysis of the portal
├── .env.example                  # Environment template
└── package.json
```

## How it works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────────┐
│ API Consumer     │────▶│ Urja API Service  │────▶│ Legacy Portal           │
│ (curl, program)  │◀────│ (Fastify + SQLite)│◀────│ (urja-ops.flockenergy)  │
└─────────────────┘     └──────────────────┘     └─────────────────────────┘
                              │
                         Local SQLite DB
                         (meters, transformers,
                          energy readings)
```

1. **On startup**, the service logs into the portal, fetches all meters via `/portal/export` (one call) and all transformers via `/portal/dts`, and stores them in a local SQLite database.
2. **API requests** are served from the local database  -  not from the portal. This decouples availability and enables server-side filtering the portal can't do.
3. **Energy readings** are synced **on-demand**: the first request for a meter's energy triggers a fetch from the portal; subsequent requests are served from the cache.
4. **Manual re-sync** is available via `POST /api/v1/sync`.

## Key files

| File                        | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `PROTOCOL.md`               | How the legacy portal works under the hood  -  endpoints, auth, signing, quirks |
| `APPROACH.md`               | How and why I built the service this way - methodology and trade-offs        |
| `openapi.json`              | OpenAPI 3.x spec for the API (also served live at `/docs/json`)               |
| `LEGACY_SYSTEM_ANALYSIS.md` | Deep-dive technical analysis from the HAR file                                |

## Configuration

All config is via environment variables (see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORTAL_URL` | `https://urja-ops.flockenergy.tech` | Legacy portal URL |
| `PORTAL_EMAIL` | `operator@urja.local` | Portal login email |
| `PORTAL_PASSWORD` | `urja-ops-2026` | Portal login password |
| `PORT` | `3000` | API service port |
| `API_KEY` | `urja-dev-key-2026` | API key for authentication |
| `DB_PATH` | `./data/urja.db` | SQLite database path |
| `PORTAL_TIMEZONE_OFFSET` | `+05:30` | Assumed timezone for portal timestamps |

## Tech stack

| Layer       | Technology               | Why                                                                                                                                |
| ----------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Runtime     | Node.js 20+ / TypeScript | Familiar, fast to build, matches portal's ecosystem                                                                                |
| Framework   | Fastify                  | Auto-generates OpenAPI from route schemas via `@fastify/swagger`                                                                   |
| Database    | SQLite (sql.js)          | Zero-setup, single file, no external server. `sql.js` chosen over `better-sqlite3` to avoid native C++ build dependency on Windows |
| HTTP Client | Node's built-in `fetch`  | No extra dependency needed for Node 20+                                                                                            |

## Assumptions

1. **Timezone is IST (+05:30).** The portal's timestamps (`DD/MM/YYYY HH:MM`) have no timezone marker. Given this is a Jaipur, India utility, I assume IST and convert to ISO 8601 with explicit offset.
2. **The portal is read-only.** I observed no write/update endpoints and the requirements state to treat it as read-only. I only perform GET requests (plus the initial POST for login).
3. **Energy readings represent ~7 days.** One sample showed 337 points of 30-min data. I don't know if this is always exactly 7 days or varies.
4. **`kwh`/`kvah` are cumulative register readings**, not per-interval consumption. I expose them as-is and document this.
5. **The signing secret from `/portal/keys` doesn't rotate** within a session. I cache it after the first fetch.
6. **Hierarchy inconsistencies are source data quality issues**, not bugs in my mapping. I store hierarchy per-meter exactly as the portal provides it.

## Design decisions & trade-offs

See `APPROACH.md` for the full discussion. Key decisions:

- **Adapter, not scraper:** Built on the portal's clean `/portal/*` JSON endpoints, not HTML scraping.
- **Local SQLite cache:** Enables filtering the portal can't do, decouples from portal availability.
- **On-demand energy sync:** Avoids making individual HTTP calls for every meter on startup; trades first-request latency for startup speed.
- **Single API key:** Appropriate for internal consumers; upgrade path to per-consumer keys is documented.
- **No scheduled sync:** Sync on startup + manual trigger is sufficient for the product scope.

## What I intentionally left out

1. **Scheduled background sync**  -  would run on a cron. Not needed to demonstrate the architecture.
2. **Computed energy deltas**  -  the portal sends cumulative readings. Per-interval consumption would be useful but adds complexity.
3. **Network hierarchy reconstruction**  -  optional extension. I store hierarchy flat per-meter.
4. **Geo/spatial queries**  -  optional extension, would need a spatial index.
5. **Circuit breaker**  -  implemented as simple retry on auth failure. Production would want a proper circuit breaker.
6. **Docker / containerization**  -  would add ~10 lines of Dockerfile but isn't required.

## What I'd improve with more time

1. **Background sync**  -  periodic poll of `/portal/export` and rolling energy sync per meter.
2. **Staleness headers**  -  expose `last_synced_at` in response headers.
3. **Energy deltas**  -  compute per-interval consumption from cumulative readings.
4. **Integration tests**  -  contract tests against recorded portal responses.
5. **Rate limiting**  -  per-API-key limits.
6. **Docker**  -  for reproducible deployment.
7. **Enhanced Web Dashboard** - expand the built-in dashboard with map layers, CSV exports, or advanced operational analytics.

### What assumptions did you make?

The biggest assumption was the timezone: the portal's timestamps (`23/06/2026 23:30`) carry no timezone marker. Since this is a Jaipur, Rajasthan utility, IST (+05:30) is the only reasonable assumption - but it's an assumption, not a fact the API tells me. I made it explicit by hardcoding the offset as a config variable that can be changed if wrong.
I also assumed the signing secret from `/portal/keys` is stable within a session and doesn't rotate between calls. This held true in all my testing but isn't guaranteed.

### Which part was the most difficult, and how did you get unstuck?

The HMAC signature for `/portal/export` was by far the hardest. I spent significant time trying to brute-force the message format from request/response pairs  -  testing ~1,400 combinations of method+path+timestamp with different separators, JSON-encoded bodies, derived key schemes, and more with the help of an agent/LLM. None matched. (Note: Testing here refers to examining the browser network tab, inspecting XHR requests, and parsing the legacy server's HAR file.)
I got unstuck by switching from guessing to reading: the portal's client-side JS bundle on the `/transformers` page contains the signing function in readable form. The key insight was that `params` is a separate field joined with newlines  -  a format I hadn't tried because it's unusual. **Lesson: read the source when you can. It's always faster than guessing.**
A second gotcha was the SvelteKit CSRF check: my first live login attempt failed with "Cross-site" because SvelteKit form actions verify the `Origin` header matches the server's domain. Browsers send this automatically; server-side clients don't. Adding `Origin: https://urja-ops.flockenergy.tech` fixed it immediately. This wasn't visible in the HAR analysis.

### If you had another day, what would you improve?

Background sync on a schedule (cron), computed energy consumption deltas (per-interval usage from cumulative readings), Docker packaging, and enhancing the web dashboard with map layers showing consumption overlays.

### What mistake did you make while solving this?

Spending too long trying to brute-force the HMAC signature from sample data instead of immediately going to read the source JS. The HAR analysis and the systematic search (~1,400 combinations) using an agent/LLM were thorough but fundamentally the wrong approach when the exact algorithm was sitting in a publicly accessible JS file. In hindsight, "read the page source" should have been step 1, not step N.
The second mistake was not testing the login against the live portal earlier. The SvelteKit CSRF check (requiring a matching `Origin` header) only surfaced on the first real HTTP call  -  it's invisible in HAR analysis because browsers handle it transparently.

### If you were reviewing your own submission, what would you criticise?

1. **No automated tests.** The service works end-to-end (verified manually), but there are no unit tests for the normalization logic, query functions, or signing module. These would be the first thing I'd add.
2. **No staleness awareness in responses.** The `syncedAt` timestamp is in the response body but there's no header or envelope-level indicator of data freshness. A consumer can't tell at a glance whether they're looking at data from 5 minutes ago or 5 hours ago.
