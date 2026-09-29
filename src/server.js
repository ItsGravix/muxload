import { decodeBatch, BATCH_CONTENT_TYPE } from "./protocol.js";

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class KeyedLock {
  #tails = new Map();

  async run(keys, work) {
    const uniqueKeys = [...new Set(keys)].sort();
    const releases = [];
    for (const key of uniqueKeys) {
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

function asHttpError(error) {
  if (Number.isInteger(error?.status)) return error;
  return new HttpError(500, "The upload server could not process the request.");
}

function sendError(response, error) {
  const safe = asHttpError(error);
  response.status(safe.status).json({ error: safe.message, ...safe.details });
}

function validateUpload(upload, id) {
  if (!upload || upload.id !== id) throw new HttpError(404, "Upload session not found.");
  if (!Number.isSafeInteger(upload.size) || upload.size < 0) throw new TypeError("resolveUpload() returned an invalid size.");
  if (!Number.isSafeInteger(upload.offset) || upload.offset < 0 || upload.offset > upload.size) {
    throw new TypeError("resolveUpload() returned an invalid offset.");
  }
  return upload;
}

export function createExpressUploadRouter(options) {
  const {
    express,
    createUpload,
    resolveUpload,
    writePart,
    completeUpload,
    removeUpload,
  } = options;
  if (!express?.Router) throw new TypeError("Pass the Express module as options.express.");
  for (const [name, value] of Object.entries({ createUpload, resolveUpload, writePart, completeUpload, removeUpload })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  }

  const maxBatchBytes = options.maxBatchBytes ?? 4 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 64;
  const locks = new KeyedLock();
  const router = express.Router();

  router.post("/uploads", express.json({ limit: "32kb" }), async (request, response) => {
    try {
      const specification = request.body;
      if (!specification || typeof specification.name !== "string" || !specification.name
        || !Number.isSafeInteger(specification.size) || specification.size < 0
        || typeof specification.metadata !== "object" || specification.metadata === null
        || Array.isArray(specification.metadata)) {
        throw new HttpError(400, "Invalid upload specification.");
      }
      const upload = await createUpload(request, specification);
      validateUpload(upload, upload?.id);
      response.status(201).json({ id: upload.id, offset: upload.offset });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/batches", express.raw({
    type: BATCH_CONTENT_TYPE,
    limit: maxBatchBytes + 64 * 1024,
  }), async (request, response) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw new HttpError(415, `Use ${BATCH_CONTENT_TYPE}.`);
      const decoded = decodeBatch(request.body, { maxEntries });
      const payloadBytes = decoded.entries.reduce((sum, entry) => sum + entry.length, 0);
      if (payloadBytes > maxBatchBytes) throw new HttpError(413, "Upload batch is too large.");

      const result = await locks.run(decoded.entries.map((entry) => entry.id), async () => {
        const resolved = new Map();
        for (const entry of decoded.entries) {
          resolved.set(entry.id, validateUpload(await resolveUpload(request, entry.id), entry.id));
        }

        for (const entry of decoded.entries) {
          const upload = resolved.get(entry.id);
          if (entry.offset > upload.offset || entry.offset < upload.offset && entry.offset + entry.length > upload.offset) {
            const offsets = Object.fromEntries([...resolved].map(([id, value]) => [id, value.offset]));
            throw new HttpError(409, "Upload offsets no longer match.", { offsets });
          }
          if (entry.offset + entry.length > upload.size) throw new HttpError(400, "A part exceeds its file size.");
        }

        for (const entry of decoded.entries) {
          const upload = resolved.get(entry.id);
          if (entry.offset + entry.length <= upload.offset) continue;
          await writePart(request, upload, entry.bytes, entry.offset);
          upload.offset = entry.offset + entry.length;
        }
        return Object.fromEntries([...resolved].map(([id, upload]) => [id, upload.offset]));
      });
      response.json({ offsets: result });
    } catch (error) {
      sendError(response, error instanceof TypeError ? new HttpError(400, error.message) : error);
    }
  });

  router.get("/status", async (request, response) => {
    try {
      const ids = String(request.query.ids || "").split(",").filter(Boolean);
      if (!ids.length || ids.length > maxEntries) throw new HttpError(400, "Provide one or more upload ids.");
      const offsets = {};
      for (const id of ids) offsets[id] = validateUpload(await resolveUpload(request, id), id).offset;
      response.json({ offsets });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post("/uploads/:id/complete", express.json({ limit: "1kb" }), async (request, response) => {
    try {
      const result = await locks.run([request.params.id], async () => {
        const upload = validateUpload(await resolveUpload(request, request.params.id), request.params.id);
        if (upload.offset !== upload.size) throw new HttpError(409, "Upload is not complete.", { offset: upload.offset });
        return completeUpload(request, upload);
      });
      response.json(result ?? { id: request.params.id, complete: true });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete("/uploads/:id", async (request, response) => {
    try {
      await locks.run([request.params.id], async () => {
        const upload = validateUpload(await resolveUpload(request, request.params.id), request.params.id);
        await removeUpload(request, upload);
      });
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

export { HttpError as UploadHttpError };
