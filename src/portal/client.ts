import { config } from "../config.js";
import { generateSignature } from "./signing.js";
import type {
  PortalPaginatedResponse,
  PortalDataResponse,
  PortalMeterSummary,
  PortalMeterGeo,
  PortalEnergyReading,
  PortalTransformer,
  PortalExportMeter,
  PortalKeys,
  PortalLoginResponse,
} from "./types.js";

/**
 * HTTP client for the legacy Urja Meter Ops portal.
 *
 * Manages session lifecycle (login, cookie storage, proactive refresh),
 * handles the HMAC signing dance for /portal/export, and provides typed
 * wrappers for every portal endpoint the service needs.
 */
export class PortalClient {
  private baseUrl: string;
  private email: string;
  private password: string;
  private sessionCookie: string | null = null;
  private sessionExpiresAt: number = 0; // Unix ms
  private signingSecret: string | null = null;

  constructor() {
    this.baseUrl = config.portal.url;
    this.email = config.portal.email;
    this.password = config.portal.password;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  /**
   * POST /login — authenticate and store session cookie.
   * The portal returns a SvelteKit form-action JSON, not a real redirect.
   */
  async login(): Promise<void> {
    const body = new URLSearchParams({
      email: this.email,
      password: this.password,
    });

    const res = await fetch(`${this.baseUrl}/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-sveltekit-action": "true",
        // SvelteKit checks Origin against the host for CSRF protection on form actions.
        // Our server-side client must present a matching Origin to pass this check.
        "Origin": this.baseUrl,
        "Referer": `${this.baseUrl}/login`,
      },
      body: body.toString(),
      redirect: "manual", // Don't follow redirects — we handle the SvelteKit JSON response
    });

    // Extract session cookie from Set-Cookie header
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const sessionCookie = setCookie.find((c) =>
      c.includes("better-auth.session_token=")
    );

    if (!sessionCookie) {
      // Fallback: check if the response body indicates success
      const json = (await res.json()) as PortalLoginResponse;
      if (json.type !== "redirect" || json.location !== "/meters") {
        throw new Error(
          `Portal login failed: unexpected response ${JSON.stringify(json)}`
        );
      }
      // Even without seeing Set-Cookie (HAR artifact), try to proceed
      // by checking all cookies in the header
      const rawCookies = res.headers.get("set-cookie") || "";
      if (rawCookies) {
        this.sessionCookie = rawCookies;
      } else {
        throw new Error(
          "Portal login succeeded but no session cookie received. " +
          "Check if the portal requires HTTPS or if cookies are being stripped."
        );
      }
    } else {
      // Parse just the cookie value (everything before the first ";")
      this.sessionCookie = sessionCookie.split(";")[0];
    }

    // Session lasts 1 hour (Max-Age=3600). Refresh 5 minutes early.
    this.sessionExpiresAt = Date.now() + 55 * 60 * 1000;
    this.signingSecret = null; // Invalidate cached signing secret on new session

    console.log("[portal] Logged in successfully");
  }

  /**
   * Ensure we have a valid session. Re-login if expired or about to expire.
   */
  private async ensureAuth(): Promise<void> {
    if (!this.sessionCookie || Date.now() >= this.sessionExpiresAt) {
      await this.login();
    }
  }

  // ─── HTTP helpers ────────────────────────────────────────────────────────

  /**
   * Make an authenticated GET request to the portal.
   * Retries once on suspected auth failure (re-login + retry).
   */
  private async portalGet<T>(
    path: string,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    await this.ensureAuth();

    const doFetch = async (): Promise<T> => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Cookie: this.sessionCookie!,
          ...extraHeaders,
        },
      });

      // If we get a redirect or auth-looking failure, try re-login once
      if (res.status === 401 || res.status === 403 || res.status === 302) {
        throw new AuthError(res.status);
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Portal ${path} returned ${res.status}: ${text.slice(0, 200)}`
        );
      }

      return (await res.json()) as T;
    };

    try {
      return await doFetch();
    } catch (err) {
      if (err instanceof AuthError) {
        console.log(
          `[portal] Auth failure on ${path} (${err.status}), re-logging in…`
        );
        await this.login();
        return await doFetch();
      }
      throw err;
    }
  }

  // ─── Portal endpoints ───────────────────────────────────────────────────

  /**
   * GET /portal/meters/search — paginated meter list.
   * The portal only searches by meter ID and serial number.
   */
  async searchMeters(
    q: string = "",
    page: number = 1
  ): Promise<PortalPaginatedResponse<PortalMeterSummary>> {
    return this.portalGet(
      `/portal/meters/search?q=${encodeURIComponent(q)}&page=${page}`
    );
  }

  /**
   * GET /portal/meters/{meterId}/geo — lat/long for a single meter.
   * Note: returns {latitude, longitude} as strings (different from export's {lat, lng} as numbers).
   */
  async getMeterGeo(
    meterId: string
  ): Promise<PortalDataResponse<PortalMeterGeo>> {
    return this.portalGet(`/portal/meters/${encodeURIComponent(meterId)}/geo`);
  }

  /**
   * GET /portal/meters/{meterId}/energy — 30-min interval energy readings.
   * Returns ~7 days of data, timestamps as "DD/MM/YYYY HH:MM" local strings.
   */
  async getMeterEnergy(
    meterId: string
  ): Promise<PortalDataResponse<PortalEnergyReading[]>> {
    return this.portalGet(
      `/portal/meters/${encodeURIComponent(meterId)}/energy`
    );
  }

  /**
   * GET /portal/dts — paginated distribution transformer list.
   */
  async getTransformers(
    page: number = 1
  ): Promise<PortalPaginatedResponse<PortalTransformer>> {
    return this.portalGet(`/portal/dts?page=${page}`);
  }

  /**
   * GET /portal/keys — fetch the HMAC signing secret.
   * Cached for the lifetime of the current session.
   */
  async getSigningSecret(): Promise<string> {
    if (this.signingSecret) return this.signingSecret;

    const res = await this.portalGet<PortalDataResponse<PortalKeys>>(
      "/portal/keys"
    );
    this.signingSecret = res.data.signingSecret;
    return this.signingSecret;
  }

  /**
   * GET /portal/export — bulk export of all meters with hierarchy + geo.
   * Requires x-signature and x-timestamp headers (HMAC-SHA256 signed).
   * Ignores the page parameter — always returns everything.
   */
  async getExport(): Promise<{ data: PortalExportMeter[]; total: number }> {
    const secret = await this.getSigningSecret();

    const params = "page=1";
    const { timestamp, signature } = generateSignature(
      "GET",
      "/portal/export",
      params,
      secret
    );

    return this.portalGet(`/portal/export?${params}`, {
      "x-signature": signature,
      "x-timestamp": timestamp,
    });
  }

  /**
   * Check if the portal is reachable (simple connectivity test).
   */
  async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/login`, { method: "HEAD" });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}

class AuthError extends Error {
  constructor(public status: number) {
    super(`Auth failure: ${status}`);
  }
}

/** Singleton portal client instance */
export const portalClient = new PortalClient();
