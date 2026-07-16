# Urja Meter Ops  -  Legacy System Analysis & Service Build Plan

**Source:** HAR capture `urja-ops_flockenergy_tech.har` (several requests, one operator session, captured 2026‑07‑15)
**Target:** `https://urja-ops.flockenergy.tech`
**Purpose:** Document exactly how the legacy portal works under the hood, and use that to design a clean API service in front of it.

> This document is the deep technical reference. `PROTOCOL.md` is the short version for anyone who just needs to understand how the portal works. (Note: Testing and analysis in this context refers to examining the browser's Network tab, inspecting XHR requests, and parsing the legacy server's HAR file.)

---

## 1. What the portal actually is

The response shapes, route naming (`/meters/__data.json`, `x-sveltekit-invalidated`, `x-sveltekit-action`), and the `{"type":"redirect","status":303,...}` login response are all distinctive **SvelteKit** artifacts. This is a server-rendered SvelteKit app, not a SPA calling a separate backend  -  the "API" is really the same routes the browser UI uses, split into two families:

- **`/*/__data.json`**  -  SvelteKit's internal "universal load" data endpoints. These back the server-rendered pages (`/meters`, `/meters/[id]`) and return data in SvelteKit's compact devalue-style array format (values referenced by index, not plain JSON). Not meant for external consumption, but readable once you know the format.
- **`/portal/*`**  -  Hand-written JSON API routes (likely `+server.ts` route handlers) that the client-side JS calls after the page has loaded, for things like pagination, per-meter drill-downs, and the bulk export. These return plain, well-formed JSON. **This is the family the new service should be built on**  -  it's already close to a real API.

There is no separate backend/microservice visible  -  everything is same-origin (`sec-fetch-site: same-origin` on every call), served by the SvelteKit app itself.

## 2. Full endpoint inventory (observed)

| # | Method | Path | Purpose | Auth signal | Notes |
|---|--------|------|---------|--------------|-------|
| 1 | POST | `/login` | Authenticate | form body | Returns `303` redirect to `/meters` on success |
| 2 | GET | `/meters/__data.json` | Page data for meters list page | session | Only returns current-user info in this capture |
| 3 | GET | `/portal/meters/search?q=&page=` | Paginated/searchable meter list | session | `q` supports free-text search (untested empty in capture) |
| 4 | GET | `/meters/{meterId}/__data.json` | Page data for a meter detail page | session | Devalue format; includes flattened hierarchy strings |
| 5 | GET | `/portal/meters/{meterId}/geo` | Lat/long for one meter | session | Tiny payload, single-purpose |
| 6 | GET | `/portal/meters/{meterId}/energy` | 30-min interval consumption for one meter | session | ~7 days of history returned |
| 7 | GET | `/portal/dts?page=` | Distribution transformer list | session | Paginated, `pageSize=20`, `total` |
| 8 | GET | `/portal/keys` | **Returns the HMAC signing secret in plaintext** | session | See §4 (security finding) |
| 9 | GET | `/portal/export?page=` | Bulk meter export (all meters, full hierarchy + geo) | session + `x-signature` + `x-timestamp` | `page` param is accepted but **ignored**  -  always returns everything |

Pages visited but not captured as page-loads themselves (inferred from `referer` headers): `/login`, `/meters`, `/meters/{id}`, `/transformers`. `/transformers` is presumably where the DT list, keys, and export calls are triggered from (an "Export" button).

## 3. Authentication flow

```
POST /login
  Content-Type: application/x-www-form-urlencoded
  body: email=operator%40urja.local&password=urja-ops-2026
  header: x-sveltekit-action: true    (marks this as a SvelteKit form action, not a page nav)

→ 200 OK
  {"type":"redirect","status":303,"location":"/meters"}
```

This is SvelteKit's standard "form action" response shape  -  the client-side router receives a JSON instruction to redirect to `/meters` rather than the browser following a real 303. **The captured HAR's response headers included no `Set-Cookie`**  -  that turned out to be a HAR-export artifact, not reality (see below).

**Cookie confirmed  -  not present in the HAR, supplied separately by direct browser inspection of the live portal:**

```
Set-Cookie (POST /login response):
  __Secure-better-auth.session_token=oW0Ku46gIMycdbs2MJwhB8Llbwbt2mwP.08n9WumttbBv0YQx7ViXboGQNfdM4jqGJfg3l48Re6U%3D;
  Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax

Cookie (subsequent request, e.g. GET /portal/meters/search?q=&page=1):
  perf_dv6Tr4n=1; __Secure-better-auth.session_token=oW0Ku46gIMycdbs2MJwhB8Llbwbt2mwP.08n9WumttbBv0YQx7ViXboGQNfdM4jqGJfg3l48Re6U%3D
```

This confirms the mechanism guessed above (standard SvelteKit cookie session) and resolves the gap flagged in the original HAR-only analysis. Key implications for the client implementation:

- **Cookie name:** `__Secure-better-auth.session_token`. The `__Secure-` prefix is a browser-enforced prefix (requires the `Secure` attribute, HTTPS-only)  -  a server-side HTTP client doesn't need to do anything special with it beyond sending it back verbatim on every request, but it does confirm the portal is HTTPS-only end to end.
- **The `__Secure-better-auth.` naming is a strong signal the portal is using [better-auth](https://www.better-auth.com/) (a popular Node/TypeScript auth library)** for session management. Useful context if the new service ever needs to reason about session lifecycle beyond what's captured here (better-auth's docs describe its default expiry/refresh behavior)  -  but for my purposes the token itself should be treated as an opaque bearer value; don't try to decode or validate it locally.
- **`Max-Age=3600`**  -  the session is valid for **1 hour** from issuance. The new service's portal client must either re-authenticate (`POST /login` again) proactively before expiry, or detect a failed/redirected response on a `/portal/*` call and re-authenticate reactively. I don't yet have a captured "expired session" response (see §9), so build for both: refresh a few minutes before the hour is up, *and* handle an auth-looking failure by re-logging in once and retrying.
- **`HttpOnly; Secure; SameSite=Lax`**  -  standard flags that matter to browsers, not to a server-side client; just store and resend the cookie value on every request.
- **The `perf_dv6Tr4n` cookie** riding alongside it is almost certainly an analytics/performance-monitoring cookie (name pattern matches vendor-injected RUM/perf beacons), not part of auth. Safe to ignore  -  the new service's client doesn't need to send it, and there's no harm if it does.

No CSRF token, bearer token, or API key was observed on any request other than the export signature (§4). Auth for every `/meters/*` and `/portal/*` call is this one session cookie.

## 4. The `/portal/export` signature scheme

This is the most interesting  -  and most broken  -  part of the portal.

Sequence observed (all within ~1 second, from the `/transformers` page):

```
GET /portal/keys
→ 200 {"data":{"signingSecret":"I3dZPPf5CgTp7JyGNMI8i6z8LFR7TmSR"}}

GET /portal/export?page=1
  x-signature: 9bf5f569e801e21555700fbe50099c7050f72b09fc794dfc030e437a3f60267c
  x-timestamp: 1784117506
→ 200  (full dump of records)
```

`x-timestamp` (`1784117506`) matches the request's wall-clock time exactly (`2026-07-15T12:11:46Z`), confirming it's a Unix-epoch anti-replay timestamp, presumably checked server-side against some tolerance window (e.g. ±5 min).

**Finding: the client fetches its own signing secret from an unauthenticated-looking, un-signed endpoint (`/portal/keys`) 42ms before using it.** Whatever this signature scheme is meant to protect against (tampering, hot-linking, replay), it provides no real protection: any client that can reach `/portal/export` can also reach `/portal/keys` and mint its own valid signature. This is "security theatre"  -  worth flagging to the utility, and it's *good news* for me: it means I don't need to reverse-engineer the exact HMAC message format under adversarial conditions, I can just replicate the same two-call pattern (fetch secret, then sign) inside the service.

**Not yet reverse-engineered:** the exact string that gets HMAC'd. I now have **two** real samples (same secret, same `page=1`, different timestamps):

```
ts=1784117506  path=/portal/export?page=1  sig=9bf5f569e801e21555700fbe50099c7050f72b09fc794dfc030e437a3f60267c
ts=1784131207  path=/portal/export?page=1  sig=6c869084d1aac14e8aee74db007ac790cda4a391768bcfc28884b0b534892645
```

Both are 64-hex-char digests, consistent with a SHA-256-family output (HMAC-SHA256 or plain SHA-256). Since `secret` and `path` are identical between the two samples but the signatures differ, the timestamp must factor into the message (or a derived key) somehow  -  that's the one solid constraint.

We ran a systematic search against both samples together (i.e. a candidate is only accepted if it reproduces *both* signatures) covering:
- `HMAC-SHA256(secret, message)` for `message` built from every ordered combination of `{method, path-variant, timestamp}` (path variants: with/without query string, full URL, route name alone, `page=1` alone, `1` alone; methods: `GET`, `get`, omitted), joined with a wide range of separators (empty, `:`, `.`, newline, `|`, `-`, `_`, space, `,`, `&`, `+`)  -  I tested ~1,400 combinations with the help of an agent/LLM, no match.
- Plain `SHA-256`/`SHA-1`/`MD5`/`SHA-512` of the secret concatenated with path/timestamp in various orders  -  no match.
- Two-step/derived-key schemes: `key = HMAC(secret, timestamp); sig = HMAC(key, path)` and the reverse (`key = HMAC(timestamp, secret)`)  -  no match.
- `HMAC(secret, timestamp)` alone (no path at all) and `HMAC(timestamp, secret)`  -  no match.
- Timestamp in milliseconds instead of seconds  -  no match.
- JSON-encoded message bodies (`{"page":1,"timestamp":...}` and `{"timestamp":...,"page":1}`, compact separators) and query-string-shaped messages (`page=1&timestamp=...`)  -  no match.

**Conclusion: this isn't a simple, guessable canonicalization**  -  it likely involves something not visible in the HTTP traffic at all (e.g. a per-session value, the logged-in user's id/email folded into the message, a different key derivation, or an encoding step like base64/UTF-16 on the secret before use). Guessing further isn't a good use of time. **The reliable way to close this out is to read the signing function directly from the portal's client-side JS bundle**  -  the `/transformers` page ships the code that calls `/portal/keys` and then signs the export request, so the exact algorithm is sitting in a `.js` file the browser already downloads. Open DevTools → Sources (or Network → find the JS chunk loaded on `/transformers` → view it, possibly minified but `grep`-able for `signature`, `hmac`, `sign`, or the literal string `x-signature`) and pull the function verbatim. That's a five-minute task with browser access and will save more guessing than any number of additional signature samples would.

## 5. Data model (as reconstructed from `/portal/export`)

`/portal/export` is the richest single endpoint  -  it returns every meter with its full network hierarchy and geo in one call, so it's the best "source of truth" shape to design the new service's schema around.

```
Meter
├─ meterId        string   e.g. "J100000"   sequential meter IDs
├─ serialNo        string   e.g. "SE33962" (vendor-prefixed, not globally unique-looking format-wise but appears unique)
├─ make            enum     HPL | Genus | Secure | Allied | L&T
├─ phaseType       enum     single | three
├─ installStatus   enum     Installed | Faulty | Decommissioned
├─ installType     enum     Whole Current | CT Operated
├─ build           enum     legacy | v2        ← two generations of meter firmware/hardware
├─ dtCode          string   FK → DistributionTransformer.code
├─ hierarchy
│   ├─ zone         {name, code}     zones (Z-01..Z-03)
│   ├─ circle       {name, code}
│   ├─ division     {name, code}
│   ├─ subdivision  {name, code}
│   ├─ substation   {name, code}
│   ├─ feeder       {name, code}
│   └─ dt           {name, code}    (duplicates dtCode/DT name)
└─ geo             {lat, lng}        per-meter, not per-DT (see §6 quirk)

DistributionTransformer (from /portal/dts)
├─ code            string   "DT-001".."DT-040"  -  transformers
├─ name            string   e.g. "Malviya Nagar DT 1"
├─ feederCode      string   FK → Feeder
└─ capacityKva     number   63 | 100 | 160 | 250 | 400

EnergyReading (from /portal/meters/{id}/energy)
├─ timestamp   string  "DD/MM/YYYY HH:MM" (30-min resolution, NOT ISO 8601)
├─ kwh         string  cumulative register reading (numeric, but sent as string)
├─ kvah        string  cumulative register reading (numeric, but sent as string)
└─ voltR       string  instantaneous R-phase voltage (numeric, but sent as string)
```

The `/meters/{id}/__data.json` page-data endpoint exposes the same meter+hierarchy info as a flattened, display-oriented structure (`"Jaipur Zone 1 (Z-01)"` as one string, parameter/value pairs for the detail table)  -  useful for confirming field labels, but strictly worse than `/portal/export` as a data source.

## 6. Data quality quirks worth knowing about

Checked all export records for internal consistency:

- **Hierarchy is attached per-meter, not derived from a clean DT→hierarchy lookup table.** Meters sharing the same `dtCode` do *not* always report identical zone/circle/division/subdivision/substation/feeder  -  a number of the DTs have at least one meter with a different hierarchy tuple than its siblings, and some of those tuples have **blank (`""`) fields** (e.g. missing `feeder` code). This looks like genuine legacy data-quality debt (perhaps merges, re-parenting of DTs across circles over time, or copy-paste seed data), not a bug in the export endpoint. **The new service should not assume `dtCode` is a reliable key to a single canonical hierarchy**  -  store the hierarchy as it comes with each meter record, and treat blank fields as "unknown," not as an error.
- **Geo coordinates are per-meter, not per-DT**  -  every meter under the same DT has a distinct lat/lng (makes physical sense: different customer premises), so don't try to fold geo into the DT table.
- **`/portal/export?page=1` ignores pagination** and returns all records regardless of the `page` value  -  unlike `/portal/meters/search` and `/portal/dts`, which are properly paginated at `pageSize=20`. Don't build the new service's export/sync feature assuming page-by-page fetching is required or even respected; assume "call once, get everything," but keep the `?page=` param passthrough in case the live behavior differs from this one capture.
- **`serialNo` values are messy strings**  -  e.g. `"L&84997"`  -  contains an ampersand, inconsistent prefix lengths across manufacturers. Treat as an opaque string, not a structured code.
- **Energy timestamps are `DD/MM/YYYY HH:MM` local strings**, not ISO 8601 and with no explicit timezone  -  needs explicit parsing (and a documented assumption about timezone, likely IST since this is a Jaipur, India utility) before use in any real time-series store.
- **`kwh`/`kvah`/`voltR` are JSON strings, not numbers**, and register readings (`kwh`, `kvah`) are cumulative counters, not per-interval deltas  -  the new service should decide whether to expose raw cumulative values (matching the source) or compute deltas/consumption-per-interval as a derived field (probably worth offering both).

## 7. Security observations (for the writeup / for the utility)

1. **Secret exposed to any authenticated client** (`/portal/keys`) that is then used purely to satisfy a signature check the same client can trivially pass. Effectively no protection on `/portal/export`.
2. **No visible rate limiting, no `Retry-After`, no per-IP/per-key throttling headers** on any response  -  the new service should self-impose sane rate limits when polling the portal so it doesn't hammer a system with none of its own.
3. **No CSRF token on the login form** (form POST relies solely on cookie + same-origin fetch mode)  -  not a problem to fix, but worth noting since it affects how safe it is to store/replay the portal's session cookie inside the service.
4. **No security headers observed** (`no Strict-Transport-Security`, `no X-Frame-Options`, `no Content-Security-Policy`, `no server` header) in any response in this capture  -  consistent with an old/minimally-hardened internal tool, as described.
5. Credentials (`operator@urja.local` / `urja-ops-2026`) are sent as **plain form-urlencoded body over HTTPS**  -  fine given TLS, just confirming there's no additional encryption layer to account for.

## 8. Proposed architecture for the new service

### 8.1 Shape: adapter/BFF, not a scraper of the human UI

Build a thin **backend-for-frontend service** that:
- Logs into the legacy portal once (headless HTTP, not a browser  -  no JS execution needed since every route we care about is `/portal/*` plain JSON, not a client-rendered page) and keeps the session cookie alive.
- Talks to `/portal/meters/search`, `/portal/dts`, `/portal/meters/{id}/geo`, `/portal/meters/{id}/energy`, and `/portal/export` under the hood.
- Re-implements the `/portal/export` signing dance internally (fetch secret once, cache it, sign each export call)  -  client of *my* service never needs to know this exists.
- Normalizes the messy bits from §5/§6 (string numbers → real numbers, `DD/MM/YYYY HH:MM` → ISO 8601 with explicit timezone, blank hierarchy fields → `null` instead of `""`) before handing data to consumers.
- Exposes a clean, versioned REST API with its own auth (API keys or OAuth client-credentials for the "program" consumers Product/Data teams mentioned)  -  the legacy portal's operator login stays a service-account credential inside the service, never exposed externally.

### 8.2 Proposed external API surface

```
GET  /v1/meters                        -  paginated, filterable (status, make, phaseType, dtCode, zone…)
GET  /v1/meters/{meterId}              -  single meter: identity + hierarchy + geo, merged
GET  /v1/meters/{meterId}/energy       -  consumption time series, ISO timestamps, numeric fields,
                                         optional ?from=&to=&resolution=raw|hourly|daily
GET  /v1/transformers                  -  DT list with capacity + feeder
GET  /v1/transformers/{code}/meters    -  meters attached to a DT (derived, not a native portal endpoint)
GET  /v1/export                        -  full normalized dump (mirrors /portal/export, cleaned up)
GET  /v1/health                        -  service + upstream portal reachability
```

All list endpoints: cursor or page-based pagination, consistent envelope (`{data, page, pageSize, total}`), consistent error envelope (`{error: {code, message}}`), and OpenAPI spec generated from the implementation.

### 8.3 Sync / caching strategy

Given the portal has no visible rate limits but also no evidence it's built for heavy traffic:

- **Static-ish data** (meter identity, hierarchy, DT list)  -  pull via `/portal/export` + `/portal/dts` on a schedule (e.g. every 15–30 min) into a local store (Postgres/SQLite is plenty at this scale). Serve all reads from the local store, not live from the portal, for latency and to avoid depending on portal uptime for every request.
- **Energy time series**  -  poll `/portal/meters/{id}/energy` per meter on a rolling schedule (this is the expensive one: separate calls). Since the sample showed ~7 days of 30-min data per call, a periodic pull (e.g. every few hours) is enough to stay current without hammering the endpoint; store readings keyed by `(meterId, timestamp)` so re-pulls are idempotent upserts.
- **Geo**  -  comes for free from `/portal/export`; no need to call the per-meter `/geo` endpoint at all once export is wired up.
- Add a `last_synced_at` per entity and surface staleness in responses (or at least in `/v1/health`) so downstream consumers know how fresh the data is  -  important since this is now a cache in front of a live operational system.

### 8.4 Auth for the new service

- Store portal credentials as a service-account secret (env var / secrets manager), never touched by external callers.
- New service issues its own API keys (or short-lived JWTs) to Product/Data consumers; validate on every request; log usage per key for the "who's actually using this" visibility that's presumably part of why this project exists.
- Rotate the portal's HMAC signing secret handling entirely inside the service  -  treat it as sensitive even though the portal itself leaks it.

### 8.5 Resilience

- Timeouts: portal responses in this capture were all <200ms; set client timeout generously above that (e.g. 5–10s) with retry-with-backoff on 5xx/timeout, but fail fast and surface a clear upstream-unavailable error rather than hanging.
- Circuit breaker around the portal client so a portal outage degrades to "serve cached data + flag staleness" rather than cascading failures into the new service's own API.
- Structured logging of every portal call (method, path, status, latency) for observability, since this is now an integration point Product/Data will depend on.

### 8.6 Testing

- Contract tests against recorded fixtures (this HAR is a good starting seed) so the service's parsing logic doesn't silently break if the portal changes response shape.
- A small integration smoke test that runs against the real portal (using the operator credentials) on a schedule, to catch upstream changes early  -  separate from unit tests that run against fixtures.

## 9. Open items to resolve against the live portal

1. ~~Exact cookie name/flags used for the session~~  -  **resolved.** Confirmed directly from the live portal (not present in the HAR): cookie `__Secure-better-auth.session_token`, `Max-Age=3600`, `HttpOnly; Secure; SameSite=Lax`. See §3.
2. **Exact HMAC message format** for `/portal/export`'s `x-signature` (§4)  -  only one sample available; need either a second sample (ideally with a *different* timestamp/page value than the one already captured, to triangulate what varies vs. stays constant in the signed message) or the client JS source (the bundle behind the `/transformers` page's export button almost certainly contains the signing function in cleartext  -  pulling that is likely the fastest path, faster than guessing).
3. **What `/portal/meters/search?q=...` actually matches on** (meterId? serialNo? dtCode? partial match, case sensitivity?)  -  every captured call used an empty `q`. Need one capture with a real search term.
4. **Session renewal behavior**  -  it is now known that the session lasts exactly 1 hour (`Max-Age=3600`), but not what happens right after expiry: does a `/portal/*` call return `401`, an empty/error JSON body, or a redirect-shaped response like the login form action? Need one capture of a request made with an expired/invalid cookie to know what the new service should pattern-match on to trigger re-auth.
5. **Login failure shape**  -  what does `POST /login` return on a wrong password? (status code, body) Not captured; needed so the new service can distinguish "bad credentials" from "portal down" from "network error."
6. **Whether `/portal/export` is paginated by design and `page=1` in this capture just happened to return everything because there's currently ≤ some threshold of records**, vs. being unconditionally unpaginated  -  worth testing with a `page=2` call live (not present in this HAR).
7. **Whether write operations exist at all** (this capture is 100% read-only)  -  worth a quick UI click-through on the live portal to confirm this is genuinely a read-only lookup tool, which the task description implies but doesn't state outright.
8. **Full site map**  -  this HAR only captures the paths one operator happened to click during a ~35-second session (`/meters`, `/meters/{id}`, `/transformers`). Worth a quick manual click-through of every nav item on the live portal to confirm there's nothing else (e.g. an alerts/events page, a billing page, a user-management page) that wasn't touched in this capture and so isn't documented here at all.

### Provenance note for whoever (or whatever) builds this next

Everything in §1–§8 and in the "Reference" table below comes from the HAR
file (`urja-ops_flockenergy_tech.har`) unless explicitly marked otherwise.
The session cookie details in §3 are the one exception so far  -  those were
confirmed by the task owner directly from the live portal, not from the HAR
(the HAR simply doesn't contain them; that's a HAR-export limitation, not a
finding about the portal). If more live-portal facts get supplied to fill in
§9, add them the same way: quote the raw evidence, and note explicitly that
it didn't come from the HAR, so it's clear which claims in this document are
directly reproducible from the attached capture and which rest on
out-of-band confirmation.

## 10. Reference: raw endpoint → response shape quick lookup

For anyone implementing the client, response bodies observed (types as returned, before any normalization):

```jsonc
// GET /portal/meters/search?q=&page=1
{ "data": [ { "meterId": "J100000", "serialNo": "SE33962", "make": "HPL",
              "phaseType": "single", "installStatus": "Decommissioned",
              "dtCode": "DT-001" }, /* ... */ ],
  "total": 403, "page": 1, "pageSize": 20 }

// GET /portal/meters/{id}/geo
{ "data": { "latitude": "26.938961002479868", "longitude": "75.83095696146852" } }
// NB: geo here is string lat/long with keys "latitude"/"longitude"  -  but the SAME
// data inside /portal/export uses numeric "lat"/"lng". Two different shapes for
// the same fact  -  normalize to one in the new service.

// GET /portal/meters/{id}/energy
{ "data": [ { "timestamp": "23/06/2026 23:30", "kwh": "48438.74",
              "kvah": "52313.84", "voltR": "226" }, /* ~337 points */ ] }

// GET /portal/dts?page=1
{ "data": [ { "code": "DT-001", "name": "Malviya Nagar DT 1",
              "feederCode": "F-001", "capacityKva": 100 }, /* ... */ ],
  "total": 40, "page": 1, "pageSize": 20 }

// GET /portal/keys
{ "data": { "signingSecret": "I3dZPPf5CgTp7JyGNMI8i6z8LFR7TmSR" } }

// GET /portal/export?page=1   (requires x-signature, x-timestamp headers)
{ "data": [ { "meterId": "J100000", "serialNo": "SE33962", "make": "HPL",
              "phaseType": "single", "installStatus": "Decommissioned",
              "installType": "Whole Current", "build": "legacy", "dtCode": "DT-001",
              "hierarchy": { "zone": {"name":"...","code":"Z-01"}, "circle": {...},
                              "division": {...}, "subdivision": {...},
                              "substation": {...}, "feeder": {...}, "dt": {...} },
              "geo": { "lat": 26.938961002479868, "lng": 75.83095696146852 } },
             /* all 403, ignores ?page= */ ],
  "total": 403 }
```

**Note the `geo` shape mismatch** between `/portal/meters/{id}/geo` (`latitude`/`longitude` as strings) and `/portal/export` (`lat`/`lng` as numbers)  -  one more small inconsistency to normalize away in the clean service.