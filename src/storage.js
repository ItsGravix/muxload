import { mkdir, open, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UploadHttpError } from "./server.js";

const ID_PATTERN = /^[a-f0-9-]{36}$/;

function createMemoryState() {
  const uploads = new Map();
  return {
    async get(id) { return uploads.get(id); },
    async set(upload) { uploads.set(upload.id, upload); },
    async delete(id) { uploads.delete(id); },
  };
}

function validateState(state) {
  for (const method of ["get", "set", "delete"]) {
    if (typeof state?.[method] !== "function") throw new TypeError(`state.${method} must be a function.`);
  }
  return state;
}

/** Local files with separate, replaceable resumable-upload state. */
export function createStorageContainer({
  directory,
  validate,
  finalize,
  maxFileBytes = 2 * 1024 ** 3,
  state = createMemoryState(),
} = {}) {
  if (typeof directory !== "string" || !directory.trim()) throw new TypeError("directory is required.");
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) {
    throw new TypeError("maxFileBytes must be a non-negative safe integer.");
  }
  if (validate !== undefined && typeof validate !== "function") throw new TypeError("validate must be a function.");
  if (finalize !== undefined && typeof finalize !== "function") throw new TypeError("finalize must be a function.");
  const uploadState = validateState(state);
  const root = path.resolve(directory);
  const location = (id) => {
    if (!ID_PATTERN.test(id)) throw new UploadHttpError(404, "Upload not found.");
    return path.join(root, id);
  };
  return {
    async createUpload(context, spec) {
      if (spec.size > maxFileBytes) throw new UploadHttpError(413, "File is too large.");
      await validate?.(context, spec);
      const upload = { id: randomUUID(), name: spec.name, metadata: spec.metadata, size: spec.size, offset: 0 };
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(location(upload.id), new Uint8Array(), { flag: "wx", mode: 0o600 });
      try { await uploadState.set(upload); }
      catch (error) { await rm(location(upload.id), { force: true }).catch(() => {}); throw error; }
      return upload;
    },
    async resolveUpload(context, id) {
      const upload = await uploadState.get(id);
      if (!upload) throw new UploadHttpError(404, "Upload not found.");
      return upload;
    },
    async writePart(context, upload, bytes, offset) {
      const file = await open(location(upload.id), "r+");
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error("Storage write made no progress.");
          written += result.bytesWritten;
        }
        await file.sync();
      } finally { await file.close(); }
      await uploadState.set({ ...upload, offset: offset + bytes.length });
    },
    async completeUpload(context, upload) {
      if (upload.complete) return upload.result;
      const filePath = location(upload.id);
      const completedUpload = {
        ...upload,
        path: filePath,
        createReadStream: (options) => createReadStream(filePath, options),
      };
      const result = await finalize?.(context, completedUpload) ?? { id: upload.id, complete: true };
      await uploadState.set({ ...upload, complete: true, result });
      return result;
    },
    async removeUpload(context, upload) {
      await rm(location(upload.id), { force: true });
      await uploadState.delete(upload.id);
    },
  };
}
