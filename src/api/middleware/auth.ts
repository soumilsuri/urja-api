import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../../config.js";

/**
 * API key authentication via X-API-Key header.
 *
 * For the assignment scope, a single static key is sufficient.
 * Production upgrade path: per-consumer keys stored in DB with
 * rate limits and usage tracking per key.
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers["x-api-key"];

  if (!apiKey || apiKey !== config.api.apiKey) {
    reply.status(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing or invalid API key. Provide a valid X-API-Key header.",
      },
    });
  }
}
