import "dotenv/config";
import { randomUUID } from "crypto";
import path from "path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import authPlugin from "./plugins/auth";
import errorHandlerPlugin from "./plugins/error-handler";
import authRoutes from "./routes/auth";
import userRoutes from "./routes/users";
import chatRoutes from "./routes/chats";
import messageRoutes from "./routes/messages";
import groupRoutes from "./routes/groups";
import attachmentRoutes from "./routes/attachments";
import callRoutes from "./routes/calls";
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
  // Serves public/uploads/<file> at /uploads/<file> — Next.js did this
  // automatically for anything under public/; Fastify needs it explicit.
  await fastify.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/"
  });
  await fastify.register(authPlugin);
  await fastify.register(errorHandlerPlugin);

  fastify.addHook("onRequest", async (request) => {
    request.log.info({ timeZone: request.headers["time-zone"] ?? null }, "request");
  });

  fastify.get("/", async () => ({ ok: true, service: "nivichat-backend" }));

  await fastify.register(authRoutes, { prefix: "/api/auth" });
  await fastify.register(userRoutes, { prefix: "/api/users" });
  await fastify.register(chatRoutes, { prefix: "/api/chats" });
  await fastify.register(messageRoutes, { prefix: "/api/messages" });
  await fastify.register(groupRoutes, { prefix: "/api/groups" });
  await fastify.register(attachmentRoutes, { prefix: "/api/attachments" });
  await fastify.register(callRoutes, { prefix: "/api/calls" });

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
