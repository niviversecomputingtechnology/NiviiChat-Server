import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { withAuth } from "@/lib/middleware";
import { buildSuccess } from "@/lib/response";
import { ApiError } from "@/lib/errors";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
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

// POST /api/attachments — multipart upload, returns { url, type, ... } for use in a message.
export const POST = withAuth(async (req) => {
  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    throw new ApiError("Multipart field 'file' is required", 400);
  }
  if (file.size === 0) {
    throw new ApiError("Uploaded file is empty", 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new ApiError("File exceeds the 25MB upload limit", 413);
  }

  await mkdir(UPLOAD_DIR, { recursive: true });

  const ext = path.extname(file.name || "");
  const storedName = `${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(UPLOAD_DIR, storedName), buffer);

  return buildSuccess(
    {
      url: `/uploads/${storedName}`,
      type: attachmentTypeFromMime(file.type || "application/octet-stream"),
      fileName: sanitizeFileName(file.name || storedName),
      fileSize: String(file.size)
    },
    "File uploaded",
    201
  );
});
