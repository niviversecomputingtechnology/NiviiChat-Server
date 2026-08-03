import { PrismaClient } from "@prisma/client";

// A plain singleton is enough here: unlike Next.js dev mode (which
// re-evaluates route modules on every request and would otherwise spawn a
// new PrismaClient each time), this is one long-running Fastify process —
// `tsx watch` restarts the whole process on change rather than re-importing
// modules within it.
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
});
