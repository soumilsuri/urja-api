# APPROACH.md  -  How I Built the Urja API Service

This document captures the methodology, decision-making process, and trade-offs
behind the API service. It's intended to give a reviewer (or a teammate picking
this up) full context on *why* things are the way they are, not just *what*
they are.

## Phase 1: Reconnaissance

### Starting point: a HAR file, not a spec

The portal has no API documentation. My first move was to capture a complete
browser session as a HAR file  -  logging in, browsing meters, viewing a meter
detail, and triggering the export from the transformers page. This gave me
the raw material: every HTTP request and response the portal actually makes.

### What I learned from the HAR

I analysed the HAR systematically (documented in `LEGACY_SYSTEM_ANALYSIS.md`)
and discovered:

1. **The portal is a SvelteKit app**, not a traditional backend+SPA. It has
   two families of endpoints: `/*/__data.json` (SvelteKit's internal page-data
   format, ugly) and `/portal/*` (clean JSON, clearly hand-written route
   handlers). The `/portal/*` family is what I built on.

2. **Auth is cookie-based** (`__Secure-better-auth.session_token`, 1-hour
   TTL). Login is a SvelteKit form action that returns JSON, not a real HTTP
   redirect.

3. **The bulk export endpoint** (`/portal/export`) requires HMAC-SHA256 signed
   headers. The signing secret is served in plaintext by `/portal/keys`.

4. **Data quality is messy**: string numbers, non-ISO timestamps, inconsistent
   geo field names between endpoints, and hierarchy data that isn't consistent
   across meters sharing the same DT.

(Note: Testing and analysis in this context refers to examining the browser's Network tab, inspecting XHR requests, and parsing the legacy server's HAR file.)

### Cracking the signature

The HMAC signature for `/portal/export` was the hardest piece. Initial
attempts to reverse-engineer it from sample request/response pairs failed
despite testing ~1,400 combinations of message formats with the help of an agent/LLM. The breakthrough came
from reading the portal's client-side JS bundle (on the `/transformers` page),
which contained the signing function in readable form:

```javascript
message = [method, path, params, timestamp].join('\n')
signature = HMAC-SHA256(secret, message)
```

The key insight was that `params` (query string without `?`) is a separate
field from `path`, and they're joined with newlines  -  not a format any
brute-force search had tried.

**Lesson:** When reverse-engineering, reading the source is almost always
faster than guessing, especially when you know exactly where the source lives.

### SvelteKit CSRF surprise

The first live test of my portal client failed with a `"Cross-site"` error.
SvelteKit form actions check the `Origin` header for CSRF protection. I
fixed this by adding `Origin` and `Referer` headers matching the portal's
domain to the login request  -  a detail not visible in the original HAR
analysis because browsers send these automatically.

## Phase 2: Architecture decisions

### Decision: adapter service, not a scraper

I built a **backend-for-frontend adapter** (thin proxy + local cache), not a
screen scraper. The portal already exposes clean JSON endpoints under
`/portal/*`  -  there's no HTML parsing or browser automation anywhere in this
codebase. This made the service much simpler and more reliable than a
scraping approach would have been.

### Decision: SQLite local store, not pure pass-through

At scale, the data easily fits in memory. I chose SQLite anyway because:

1. **Decouples from portal availability.** If the portal goes down, the API still
   serves the last-known-good data.
2. **Enables server-side filtering** the portal can't do. The portal search
   only works on meter ID and serial number. My API can filter by make,
   phase type, install status, zone, DT code, etc.
3. **Normalizes data once** (on sync) instead of on every request.
4. **Persists across restarts**  -  no need to re-sync from the portal every
   time the service boots (though it does refresh on startup).

We used `sql.js` (pure JavaScript SQLite) instead of `better-sqlite3` to
avoid requiring native C++ build tools on Windows  -  a pragmatic choice to
reduce setup friction.

### Decision: Fastify, not Express

Fastify was chosen over Express primarily because `@fastify/swagger` generates
the required `openapi.json` directly from route schemas. This means the API
spec and the implementation are always in sync  -  no separate spec to maintain.
The performance benefits are a nice side effect but weren't the driver.

### Decision: on-demand energy sync

Syncing energy readings for all meters on startup would require
individual HTTP calls to the portal for each meter. Instead, energy data is fetched
**on-demand**  -  the first request for a meter's energy triggers a sync from
the portal, and subsequent requests are served from the local cache.

This keeps startup fast (~2 seconds) and avoids hammering the portal
unnecessarily for meters nobody's asked about yet.

### Decision: simple API key auth

The service uses a single static API key (via `X-API-Key` header) rather than
JWT or OAuth. This is appropriate for the service scope  -  the consumers are
internal Product/Data teams, not external users. The upgrade path to
per-consumer keys with rate limiting and usage tracking is documented but not
implemented.

## Phase 3: Data normalization

The new API normalizes every inconsistency I found in the portal's data:

| Portal inconsistency | My normalization |
|---|---|
| Geo fields named `latitude`/`longitude` (strings) in one endpoint, `lat`/`lng` (numbers) in another | Always `latitude`/`longitude` as numbers |
| `kwh`, `kvah`, `voltR` as JSON strings | Always numbers |
| Timestamps as `DD/MM/YYYY HH:MM` local strings | ISO 8601 with explicit `+05:30` offset |
| Blank hierarchy fields (`""`) | `null` |
| Inconsistent hierarchy across meters sharing a DT | Stored per-meter as the portal provides it  -  not "corrected" |

The last point is deliberate: the hierarchy inconsistencies look like real
data-quality debt in the source system, not a bug in my mapping. Trying to
"fix" them would mean making assumptions about which meter has the "right"
hierarchy, which isn't my call.

## What I intentionally skipped

1. **Scheduled background sync**  -  the service syncs on startup and exposes
   a manual `POST /api/v1/sync` endpoint. Cron-based periodic sync would be
   a natural next step but isn't needed to demonstrate the architecture.

2. **Network hierarchy reconstruction**  -  listed as an optional extension.
   The hierarchy data is stored flat per-meter and exposed as-is.

3. **Geo/spatial queries**  -  would need a spatial index (PostGIS or similar).
   Not part of the core product requirements.

4. **Circuit breaker / exponential backoff**  -  mentioned in the design but
   implemented as a simple single-retry on auth failure. A production service
   would want a proper circuit breaker.

5. **Enhanced map features on web client** - the core web dashboard has been built directly inside the backend service, but advanced mapping overlays could be expanded further.

## What I'd improve with more time

1. **Background sync on a schedule**  -  poll `/portal/export` every 15-30 min
   and energy readings on a rolling per-meter basis.
2. **Staleness indicators**  -  expose `last_synced_at` more prominently in
   response headers or a response envelope field.
3. **Computed energy deltas**  -  the portal sends cumulative register readings.
   Computing per-interval consumption (delta between consecutive readings)
   would be useful for downstream consumers.
4. **Integration tests**  -  contract tests against recorded portal responses
   to catch upstream changes early.
5. **Rate limiting** - per-API-key rate limits to protect both the service
   and the upstream portal.
6. **Docker**  -  a Dockerfile for reproducible deployment.
