// Serves the built app (dist/) from the relay in production, and gzips responses for
// clients that accept it. The live history alone is ~16 MB of JSON uncompressed.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const MIN_COMPRESS_BYTES = 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".ktx2": "image/ktx2",
};
const COMPRESSIBLE = /^(text\/|application\/(json|xml|javascript)|image\/svg|model\/gltf\+json)/;

/** Sends a body, gzipped when the client accepts it and the type is worth compressing. */
export async function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders,
  body: Buffer | string,
): Promise<void> {
  let data = typeof body === "string" ? Buffer.from(body) : body;
  const type = String(headers["Content-Type"] ?? "");
  const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  if (acceptsGzip && COMPRESSIBLE.test(type) && data.length >= MIN_COMPRESS_BYTES) {
    data = await gzipAsync(data);
    headers = { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" };
  }
  res.writeHead(status, { ...headers, "Content-Length": data.length });
  res.end(data);
}

/**
 * Serves a file from `rootDir` for a GET path, falling back to index.html for paths without
 * an extension. Returns false if nothing matched. Vite's hashed /assets/ files are cached
 * for a year; everything else is revalidated.
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, rootDir: string, pathname: string): Promise<boolean> {
  const root = resolve(rootDir);
  let file = resolve(join(root, normalize(decodeURIComponent(pathname))));
  if (file !== root && !file.startsWith(root + sep)) return false; // outside root
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    if (extname(pathname)) return false;
    file = join(root, "index.html");
    if (!existsSync(file)) return false;
  }
  const immutable = pathname.startsWith("/assets/");
  await send(
    req,
    res,
    200,
    {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
    readFileSync(file),
  );
  return true;
}
