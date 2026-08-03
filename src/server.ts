import "dotenv/config";
import { randomUUID } from "crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import authPlugin from "./plugins/auth";
import errorHandlerPlugin from "./plugins/error-handler";
import { prisma } from "./lib/prisma";

const PORT = Number(process.env.API_PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN; // comma-separated allowlist; unset = allow all

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    transport: process.stdout.isTTY ? { target: "pino-pretty" } : undefined
  },
  genReqId: (req) => (req.headers["x-trace-id"] as string) || randomUUID()
});

async function main() {
  await fastify.register(cors, {
    origin: CORS_ORIGIN ? CORS_ORIGIN.split(",").map((o) => o.trim()) : true
  });
  await fastify.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 } // 25MB, matches attachments route
  });
  await fastify.register(authPlugin);
  await fastify.register(errorHandlerPlugin);

  fastify.addHook("onRequest", async (request) => {
    request.log.info({ timeZone: request.headers["time-zone"] ?? null }, "request");
  });

  fastify.get("/", async () => ({ ok: true, service: "nivichat-backend" }));

  // Resource route plugins register themselves here checkpoint by
  // checkpoint (auth/users, then chats/messages, then groups/attachments/calls).

  await fastify.listen({ port: PORT, host: HOST });
}

async function shutdown(signal: string) {
  fastify.log.info(`${signal} received, shutting down`);
  await fastify.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
