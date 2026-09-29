import { mkdir, open, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UploadHttpError } from "./server.js";
export { createMemoryStorage } from './memory-storage.js';

/** Persistent local files for one service instance/process per directory. */
export function createLocalStorage({ directory, owner, validate, finalize, maxFileBytes = 2 * 1024 ** 3 } = {}) {
  if (!directory) throw new TypeError("directory is required.");
  if (typeof owner !== "function") throw new TypeError("owner(context) is required.");
  const root = path.resolve(directory);
  const location = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new UploadHttpError(404, "Upload not found.");
    return path.join(root, id);
  };
  const identity = async (context) => {
    const value = await owner(context);
    if (typeof value !== "string" || !value) throw new UploadHttpError(401, "Authentication required.");
    return value;
  };
  const save = async (upload) => {
    const target = location(upload.id);
    const temporary = path.join(target, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(upload), { mode: 0o600 });
    await rename(temporary, path.join(target, "record.json"));
  };
  return {
    async createUpload(context, spec) {
      const user = await identity(context);
      if (spec.size > maxFileBytes) throw new UploadHttpError(413, "File is too large.");
      await validate?.(context, spec);
      const upload = { id: randomUUID(), owner: user, name: spec.name, metadata: spec.metadata, size: spec.size, offset: 0 };
      await mkdir(location(upload.id), { recursive: true, mode: 0o700 });
      await writeFile(path.join(location(upload.id), "data"), new Uint8Array(), { flag: "wx", mode: 0o600 });
      await save(upload);
      return upload;
    },
    async resolveUpload(context, id) {
      const user = await identity(context);
      let upload;
      try { upload = JSON.parse(await readFile(path.join(location(id), "record.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") throw new UploadHttpError(404, "Upload not found."); throw error; }
      if (upload.owner !== user) throw new UploadHttpError(404, "Upload not found.");
      return upload;
    },
    async writePart(context, upload, bytes, offset) {
      const file = await open(path.join(location(upload.id), "data"), "r+");
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await file.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error("Storage write made no progress.");
          written += result.bytesWritten;
        }
        await file.sync();
      } finally { await file.close(); }
      await save({ ...upload, offset: offset + bytes.length });
    },
    async completeUpload(context, upload) {
      if (upload.complete) return upload.result;
      const result = await finalize?.(context, { ...upload, path: path.join(location(upload.id), "data") }) ?? { id: upload.id, complete: true };
      await save({ ...upload, complete: true, result });
      return result;
    },
    async removeUpload(context, upload) {
      await rm(location(upload.id), { recursive: true, force: true });
    },
  };
}
