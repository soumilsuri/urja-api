import { createHmac } from "node:crypto";

/**
 * Replicates the portal's client-side signature generation for /portal/export.
 *
 * The portal's JS does:
 *   message = [method, path, params, timestamp].join('\n')
 *   signature = HMAC-SHA256(secret, message)
 *
 * Example: generateSignature("GET", "/portal/export", "page=1", secret)
 */
export function generateSignature(
  method: string,
  path: string,
  params: string,
  secret: string
): { timestamp: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = [method, path, params, timestamp].join("\n");

  const signature = createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return { timestamp, signature };
}
