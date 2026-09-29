import { UploadHttpError } from './server.js';

/** Volatile storage. Share with one upload service; records vanish on restart. */
export function createMemoryStorage({ owner, validate, finalize, maxFileBytes = 16 * 1024 ** 2, maxTotalBytes = 64 * 1024 ** 2, maxUploads = 100 } = {}) {
  if (typeof owner !== 'function') throw new TypeError('owner(context) is required.');
  for (const [name, value] of Object.entries({ maxFileBytes, maxTotalBytes, maxUploads })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  const records = new Map();
  let allocated = 0;
  const identity = async (context) => {
    const id = await owner(context);
    if (typeof id !== 'string' || !id) throw new UploadHttpError(401, 'Authentication required.');
    return id;
  };
  const resolve = async (context, id) => {
    const user = await identity(context);
    const record = records.get(id);
    if (!record || record.owner !== user) throw new UploadHttpError(404, 'Upload not found.');
    return record;
  };
  return {
    async createUpload(context, specification) {
      const user = await identity(context);
      if (specification.size > maxFileBytes) throw new UploadHttpError(413, 'File is too large.');
      await validate?.(context, specification);
      if (records.size >= maxUploads || specification.size > maxTotalBytes - allocated) {
        throw new UploadHttpError(507, 'Upload memory capacity reached.');
      }
      const record = { ...specification, id: globalThis.crypto.randomUUID(), owner: user, offset: 0,
        bytes: new Uint8Array(specification.size) };
      records.set(record.id, record);
      allocated += record.size;
      return { ...record };
    },
    async resolveUpload(context, id) { return { ...await resolve(context, id) }; },
    async writePart(context, upload, bytes, offset) {
      const record = await resolve(context, upload.id);
      if (record.complete || offset !== record.offset || offset + bytes.length > record.size) {
        throw new UploadHttpError(409, 'Upload offsets no longer match.');
      }
      record.bytes.set(bytes, offset);
      record.offset += bytes.length;
    },
    async completeUpload(context, upload) {
      const record = await resolve(context, upload.id);
      if (record.complete) return record.result;
      if (record.offset !== record.size) throw new UploadHttpError(409, 'Upload is not complete.');
      const result = await finalize?.(context, { ...record }) ?? { id: record.id, complete: true };
      record.result = result;
      record.complete = true;
      return result;
    },
    async removeUpload(context, upload) {
      const record = await resolve(context, upload.id);
      if (records.delete(record.id)) allocated -= record.size;
    },
  };
}
