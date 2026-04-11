import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { gcsReadBuffer, gcsFileExists } from "@/lib/gcs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ file: string[] }> }
) {
  const { file } = await params;
  const filename = file.join("/");
  const relPath = `articles/images/${filename}`;

  const exists = await gcsFileExists(relPath);
  if (!exists) return new NextResponse(null, { status: 404 });

  const buf = new Uint8Array(await gcsReadBuffer(relPath));
  const ext = path.extname(filename).toLowerCase();
  const contentType =
    ext === ".png" ? "image/png" :
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    ext === ".webp" ? "image/webp" :
    "application/octet-stream";

  return new NextResponse(buf, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
