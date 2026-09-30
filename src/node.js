import { createUploadHandler } from "./server.js";

/** Connect the shared handler to Node's IncomingMessage and ServerResponse. */
export function createNodeUploadHandler(options) {
  const handleUpload = createUploadHandler(options);
  const basePath = `/${String(options.basePath ?? "").replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");

  return async function handleNodeUpload(request, response, context = request) {
    try {
      const pathname = new URL(request.url, "http://parcelweave.internal").pathname;
      if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;
      const result = await handleUpload({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
      }, context);
      // Upload responses are small JSON values; uploaded bytes are read with the
      // shared handler's body limits, never buffered here as a whole file.
      const bytes = new Uint8Array(await result.arrayBuffer());
      if (response.destroyed) return true;
      for (const [name, value] of result.headers) response.setHeader(name, value);
      // A rejected/unneeded body may still be arriving. Close after the response
      // instead of draining an unbounded body or reusing this connection.
      if (!request.readableEnded && request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Connection", "close");
        response.once("finish", () => request.destroy());
      }
      response.statusCode = result.status;
      response.end(bytes);
    } catch {
      if (!response.destroyed) {
        if (response.headersSent) response.destroy();
        else {
          response.writeHead(500, { "Content-Type": "application/json", "Connection": "close" });
          response.end(JSON.stringify({ error: "The upload server could not process the request." }));
        }
      }
    }
    return true;
  };
}
