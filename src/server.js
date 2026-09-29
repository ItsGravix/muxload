import { decodeBatch, BATCH_CONTENT_TYPE } from "./protocol.js";

export class UploadHttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "UploadHttpError";
    this.status = status;
    this.details = details;
  }
}

class KeyedLock {
  #tails = new Map();

  async run(keys, work) {
    const releases = [];
    for (const key of [...new Set(keys)].sort()) {
      const prior = this.#tails.get(key) ?? Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      const tail = prior.then(() => current);
      this.#tails.set(key, tail);
      await prior;
      releases.push(() => {
        release();
        if (this.#tails.get(key) === tail) this.#tails.delete(key);
      });
    }
    try {
      return await work();
    } finally {
      releases.reverse().forEach((release) => release());
    }
  }
}

const asHttpError = (error) => Number.isInteger(error?.status)
  ? error
  : new UploadHttpError(500, "The upload server could not process the request.");

function validateUpload(upload, id) {
  if (!upload || upload.id !== id) throw new UploadHttpError(404, "Upload session not found.");
  if (!Number.isSafeInteger(upload.size) || upload.size < 0) throw new TypeError("resolveUpload() returned an invalid size.");
  if (!Number.isSafeInteger(upload.offset) || upload.offset < 0 || upload.offset > upload.size) {
    throw new TypeError("resolveUpload() returned an invalid offset.");
  }
  return upload;
}

function validateSpecification(specification) {
  if (!specification || typeof specification.name !== "string" || !specification.name
    || !Number.isSafeInteger(specification.size) || specification.size < 0
    || typeof specification.metadata !== "object" || specification.metadata === null
    || Array.isArray(specification.metadata)) {
    throw new UploadHttpError(400, "Invalid upload specification.");
  }
  return specification;
}

/**
 * Framework-neutral protocol engine. The application supplies identity/storage
 * callbacks; Muxload owns validation, locking, offsets and retry semantics.
 */
export function createUploadService(options) {
  const callbacks = { ...options.storage, ...options };
  const { createUpload, resolveUpload, writePart, completeUpload, removeUpload } = callbacks;
  for (const [name, value] of Object.entries({ createUpload, resolveUpload, writePart, completeUpload, removeUpload })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  }
  const maxBatchBytes = options.maxBatchBytes ?? 4 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 64;
  const locks = new KeyedLock();

  return {
    maxBatchBytes,
    maxEntries,

    async create(context, specification) {
      const upload = await createUpload(context, validateSpecification(specification));
      validateUpload(upload, upload?.id);
      return { id: upload.id, offset: upload.offset };
    },

    async batch(context, body) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      let decoded;
      try { decoded = decodeBatch(bytes, { maxEntries }); }
      catch (error) {
        if (error instanceof TypeError) throw new UploadHttpError(400, error.message);
        throw error;
      }
      const payloadBytes = decoded.entries.reduce((sum, entry) => sum + entry.length, 0);
      if (payloadBytes > maxBatchBytes) throw new UploadHttpError(413, "Upload batch is too large.");

      return locks.run(decoded.entries.map((entry) => entry.id), async () => {
        const resolved = new Map();
        for (const entry of decoded.entries) {
          resolved.set(entry.id, validateUpload(await resolveUpload(context, entry.id), entry.id));
        }
        for (const entry of decoded.entries) {
          const upload = resolved.get(entry.id);
          if (entry.offset > upload.offset || entry.offset < upload.offset && entry.offset + entry.length > upload.offset) {
            const offsets = Object.fromEntries([...resolved].map(([id, value]) => [id, value.offset]));
            throw new UploadHttpError(409, "Upload offsets no longer match.", { offsets });
          }
          if (entry.offset + entry.length > upload.size) throw new UploadHttpError(400, "A part exceeds its file size.");
        }
        for (const entry of decoded.entries) {
          const upload = resolved.get(entry.id);
          if (entry.offset + entry.length <= upload.offset) continue;
          await writePart(context, upload, entry.bytes, entry.offset);
          upload.offset = entry.offset + entry.length;
        }
        return { offsets: Object.fromEntries([...resolved].map(([id, upload]) => [id, upload.offset])) };
      });
    },

    async status(context, ids) {
      if (!Array.isArray(ids) || !ids.length || ids.length > maxEntries) {
        throw new UploadHttpError(400, "Provide one or more upload ids.");
      }
      const offsets = {};
      for (const id of ids) offsets[id] = validateUpload(await resolveUpload(context, id), id).offset;
      return { offsets };
    },

    async complete(context, id) {
      return locks.run([id], async () => {
        const upload = validateUpload(await resolveUpload(context, id), id);
        if (upload.offset !== upload.size) throw new UploadHttpError(409, "Upload is not complete.", { offset: upload.offset });
        return await completeUpload(context, upload) ?? { id, complete: true };
      });
    },

    async remove(context, id) {
      await locks.run([id], async () => {
        const upload = validateUpload(await resolveUpload(context, id), id);
        await removeUpload(context, upload);
      });
    },
  };
}

const jsonResponse = (payload, status = 200, headers) => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
});

async function readLimitedBody(request, maximumBytes) {
  if (!request.body?.getReader) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new UploadHttpError(413, "Upload batch is too large.");
    return bytes;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new UploadHttpError(413, "Upload batch is too large.");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/**
 * Portable Request -> Response handler for Workers, serverless runtimes and
 * frameworks that use the Web Fetch API.
 */
export function createFetchUploadHandler(options) {
  const service = createUploadService(options);
  const basePath = `/${String(options.basePath ?? "").replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");
  const responseHeaders = options.responseHeaders ?? {};

  return async function handleUpload(request, context = request) {
    try {
      const url = new URL(request.url);
      const path = basePath && url.pathname.startsWith(`${basePath}/`)
        ? url.pathname.slice(basePath.length)
        : basePath === url.pathname ? "/" : url.pathname;
      const uploadMatch = path.match(/^\/uploads\/([^/]+)$/);
      const completeMatch = path.match(/^\/uploads\/([^/]+)\/complete$/);

      if (request.method === "POST" && path === "/uploads") {
        return jsonResponse(await service.create(context, await request.json()), 201, responseHeaders);
      }
      if (request.method === "POST" && path === "/batches") {
        if (!(request.headers.get("content-type") || "").toLowerCase().startsWith(BATCH_CONTENT_TYPE)) {
          throw new UploadHttpError(415, `Use ${BATCH_CONTENT_TYPE}.`);
        }
        const length = Number(request.headers.get("content-length"));
        if (Number.isFinite(length) && length > service.maxBatchBytes + 64 * 1024) {
          throw new UploadHttpError(413, "Upload batch is too large.");
        }
        const body = await readLimitedBody(request, service.maxBatchBytes + 64 * 1024);
        return jsonResponse(await service.batch(context, body), 200, responseHeaders);
      }
      if (request.method === "GET" && path === "/status") {
        const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
        return jsonResponse(await service.status(context, ids), 200, responseHeaders);
      }
      if (request.method === "POST" && completeMatch) {
        return jsonResponse(await service.complete(context, decodeURIComponent(completeMatch[1])), 200, responseHeaders);
      }
      if (request.method === "DELETE" && uploadMatch) {
        await service.remove(context, decodeURIComponent(uploadMatch[1]));
        return new Response(null, { status: 204, headers: responseHeaders });
      }
      return jsonResponse({ error: "Muxload route not found." }, 404, responseHeaders);
    } catch (error) {
      const safe = error instanceof SyntaxError || error instanceof TypeError
        ? new UploadHttpError(400, error.message)
        : asHttpError(error);
      return jsonResponse({ error: safe.message, ...safe.details }, safe.status, responseHeaders);
    }
  };
}

/** Thin compatibility adapter for Express applications. */
export function createExpressUploadRouter(options) {
  const { express } = options;
  if (!express?.Router) throw new TypeError("Pass the Express module as options.express.");
  const service = createUploadService(options);
  const router = express.Router();
  const sendError = (response, error) => {
    const safe = error instanceof TypeError ? new UploadHttpError(400, error.message) : asHttpError(error);
    response.status(safe.status).json({ error: safe.message, ...safe.details });
  };

  router.post("/uploads", express.json({ limit: "32kb" }), async (request, response) => {
    try { response.status(201).json(await service.create(request, request.body)); }
    catch (error) { sendError(response, error); }
  });
  router.post("/batches", express.raw({
    type: BATCH_CONTENT_TYPE,
    limit: service.maxBatchBytes + 64 * 1024,
  }), async (request, response) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw new UploadHttpError(415, `Use ${BATCH_CONTENT_TYPE}.`);
      response.json(await service.batch(request, request.body));
    } catch (error) { sendError(response, error); }
  });
  router.get("/status", async (request, response) => {
    try {
      const ids = String(request.query.ids || "").split(",").filter(Boolean);
      response.set("Cache-Control", "no-store").json(await service.status(request, ids));
    } catch (error) { sendError(response, error); }
  });
  router.post("/uploads/:id/complete", express.json({ limit: "1kb" }), async (request, response) => {
    try { response.json(await service.complete(request, request.params.id)); }
    catch (error) { sendError(response, error); }
  });
  router.delete("/uploads/:id", async (request, response) => {
    try { await service.remove(request, request.params.id); response.status(204).end(); }
    catch (error) { sendError(response, error); }
  });
  return router;
}
