import { randomUUID } from "crypto";
import { createWriteStream } from "fs";
import { mkdir, stat, unlink } from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import type { FastifyPluginAsync } from "fastify";
import { sendSuccess } from "../lib/response";
import { ApiError } from "../lib/errors";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");

function attachmentTypeFromMime(mime: string): "IMAGE" | "AUDIO" | "VIDEO" | "FILE" {
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("audio/")) return "AUDIO";
  if (mime.startsWith("video/")) return "VIDEO";
  return "FILE";
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "file";
}

const attachmentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  // POST /api/attachments — multipart upload, returns { url, type, ... } for use in a message.
  // The 25MB cap is enforced by @fastify/multipart's global limits (see server.ts).
  fastify.post("/", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      throw new ApiError("Multipart field 'file' is required", 400);
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    const ext = path.extname(file.filename || "");
    const storedName = `${randomUUID()}${ext}`;
    const destPath = path.join(UPLOAD_DIR, storedName);

    await pipeline(file.file, createWriteStream(destPath));

    if (file.file.truncated) {
      await unlink(destPath).catch(() => undefined);
      throw new ApiError("File exceeds the 25MB upload limit", 413);
    }

    const stats = await stat(destPath);
    if (stats.size === 0) {
      await unlink(destPath).catch(() => undefined);
      throw new ApiError("Uploaded file is empty", 400);
    }

    return sendSuccess(
      reply,
      {
        url: `/uploads/${storedName}`,
        type: attachmentTypeFromMime(file.mimetype || "application/octet-stream"),
        fileName: sanitizeFileName(file.filename || storedName),
        fileSize: String(stats.size)
      },
      "File uploaded",
      201
    );
  });
};

export default attachmentRoutes;
