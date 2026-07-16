# PROTOCOL.md  -  How Urja Meter Ops Actually Works

A short write-up of what I found poking at the portal, meant to save the next
person from re-discovering all of this by hand. For full endpoint-by-endpoint
detail, sample payloads, and the service design that follows from this, see
`LEGACY_SYSTEM_ANALYSIS.md`.

## What it is

Urja Meter Ops is a server-rendered **SvelteKit** app. There's no separate
backend service  -  the same app that renders the human-facing pages
(`/meters`, `/meters/{id}`, `/transformers`) also exposes a family of JSON
routes under `/portal/*` that the page's client-side JS calls for search,
drill-downs, and export. Those `/portal/*` routes are plain, well-formed
JSON and are the natural foundation for a new API  -  no scraping or HTML
parsing needed anywhere.

There's a second, uglier family of endpoints at `/*/__data.json`  -  these are
SvelteKit's own internal page-data mechanism, encoded in a compact
index-referenced format rather than plain JSON. They're what the pages use
to hydrate themselves, not really an API. I only needed to read them to
confirm field names; the real work happens on `/portal/*`.

## What data is available

- **Meters**  -  identity (meter ID, serial number, make, phase type,
  install status, install type), which distribution transformer (DT) they
  hang off, and their full network hierarchy (zone → circle → division →
  subdivision → substation → feeder → DT), plus a per-meter lat/long.
- **Distribution transformers**  -  each with a name, feeder
  code, and capacity in kVA. About 10 meters per DT on average.
- **Energy readings**  -  per meter, 30-minute-interval cumulative kWh/kVAh
  register readings plus instantaneous voltage. The one sample I captured
  had about 7 days of history (337 points) for a single meter.

That's the whole surface: no billing, no customer/contact info, no
write/update operations were seen anywhere  -  this looks like a genuinely
read-only lookup tool, matching what the product requirements imply.

The single most useful endpoint is **`/portal/export`**  -  it returns every
meter with its full hierarchy and geo in one call. That's the
best foundation to build the new service's data model around, rather than
stitching together the search/geo/detail endpoints one meter at a time.

## How you get to the data

1. `POST /login` with `email` and `password` as a form-urlencoded body.
   The response isn't a real HTTP redirect  -  it's SvelteKit's
   form-action JSON (`{"type":"redirect","status":303,"location":"/meters"}`),
   which the client-side router interprets. A plain HTTP client should treat
   a 200 with that body as "login succeeded, now go fetch `/meters`."
2. Every subsequent call is a plain `GET` to `/portal/...`, same-origin, no
   special headers except on one endpoint (see below). Nothing more exotic
   than "stay logged in and call the JSON routes."
3. Pagination is `?page=N`, `pageSize` fixed at 20, with `total` in the
   response  -  standard, except `/portal/export` **accepts but ignores**
   the `page` param and always returns everything. Don't build a
   page-loop for it; call it once.

## How auth actually works

Login clearly issues a session (nothing else would explain a 303 redirect
and every following request succeeding without credentials attached to it).
My HAR capture didn't show a `Set-Cookie` header anywhere  -  that turned out
to be a HAR-export artifact, not reality. **This has since been confirmed
directly from the live portal** (not from the HAR  -  flagging that
distinction explicitly since it matters for anyone tracing claims back to
evidence):

```
Set-Cookie (POST /login):
  __Secure-better-auth.session_token=<opaque token>;
  Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax
```

So: a standard cookie session, name `__Secure-better-auth.session_token`
(the `better-auth` in the name is a strong hint the portal is built on the
[better-auth](https://www.better-auth.com/) library), lasting **exactly one
hour** per login. Treat the token as opaque  -  store it, send it back on
every `/meters/*` and `/portal/*` call, and either refresh it proactively
before the hour is up or catch an auth failure and re-login once, retrying
the original call. A small `perf_dv6Tr4n` cookie rides along too; that's an
analytics/perf beacon, not part of auth  -  safe to ignore.

## The export "signature"  -  fully reverse-engineered

`/portal/export` requires two headers, `x-signature` and `x-timestamp`, and
`x-timestamp` is just the request's Unix time (presumably checked
server-side within some tolerance window, to stop replay). That part's
normal. What's not normal: right before calling `/portal/export`, the page
calls **`GET /portal/keys`**, which hands back the HMAC signing secret in
plain JSON  -  to any client that can load the page. So the "protection" on
the export endpoint is defeated by an endpoint sitting right next to it.
Good for me building the new service (I can just replicate the same
fetch-secret-then-sign dance), but worth flagging to the utility as a real
finding, not just a curiosity.

**The exact signing algorithm** (extracted from the portal's client-side JS
bundle on the `/transformers` page):

```javascript
message = [method, path, params, timestamp].join('\n')
signature = HMAC-SHA256(secret, message)
```

Concretely, for the export call:
- `method` = `"GET"`
- `path` = `"/portal/export"`
- `params` = `"page=1"` (query string without the `?`)
- `timestamp` = current Unix epoch in seconds, as a string

The four parts are joined with newline (`\n`) characters, then HMAC-SHA256'd
using the signing secret from `/portal/keys` as the key. The result is sent
as a lowercase hex string in the `x-signature` header alongside `x-timestamp`.

Nothing else in the portal needs a signature.

## Other surprises worth knowing about

- **The network hierarchy isn't perfectly clean.** Meters that share the
  same DT don't always report identical zone/circle/division/subdivision
  data, and some hierarchy fields come back blank for a handful of records.
  Looks like real legacy data debt (re-parenting over time, seed-data gaps)
  rather than an API bug  -  the new service should store hierarchy as
  attached per-meter and treat blanks as "unknown," not throw on them.
- **Geo lives on the meter, not the DT**  -  each meter under a DT has its
  own distinct coordinates (makes sense physically; don't try to fold geo
  into a DT-level table).
- **The same fact, two shapes.** `/portal/meters/{id}/geo` returns
  `latitude`/`longitude` as strings; `/portal/export` returns `lat`/`lng`
  as numbers for the same data. Small, but the kind of thing that'll bite
  you if you don't normalize it early.
- **Numbers travel as strings.** `kwh`, `kvah`, `voltR` in the energy
  endpoint are all JSON strings, not numbers. `kwh`/`kvah` are cumulative
  register readings, not per-interval usage  -  decide up front whether the
  new service exposes raw cumulative values, computed deltas, or both.
- **Timestamps are `DD/MM/YYYY HH:MM` local strings**, no timezone marker.
  Almost certainly IST given this is a Jaipur utility, but that's an
  assumption, not something the API tells you  -  worth confirming and then
  converting to real ISO 8601 with an explicit offset in the new service.
- No rate-limit headers, no security headers (CSP, HSTS, etc.), no `server`
  header on any response  -  consistent with an old, lightly-hardened
  internal tool. Good reason for the new service to be gentle with it
  (its own scheduling/caching, not hammering the portal on every request)
  rather than assuming it can take production-grade traffic.

## What has since been confirmed

- **`q=` on `/portal/meters/search` searches by meter ID and serial number only.**
  Confirmed via the live portal's search bar. No other fields are searchable.
- **The portal has only two sections: Meters and Transformers.** No other
  navigation items exist. It is a purely read-only lookup tool  -  no write
  or update operations anywhere.
- **SvelteKit CSRF protection:** The `POST /login` form action requires an
  `Origin` header matching the portal's own domain. A server-side client
  must send `Origin: https://urja-ops.flockenergy.tech` to pass this check.

## What remains to be verified

- What happens right when the session expires (it is now known to last exactly
  1 hour, but not whether a stale cookie gets a `401`, an error body, or a
  redirect-shaped response)  -  matters for how the new service detects
  "need to re-login."
- What a failed login (wrong password) actually returns.

These are quick to check with a live browser session or a couple of
curl calls  -  flagged here so whoever picks this up next knows exactly where
to point first.