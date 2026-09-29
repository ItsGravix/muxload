# Choose where uploaded bytes go

Muxload does not require a folder. Pass a storage adapter to the Express router, Fetch handler, or upload service. Your browser code stays the same.

## Keep files in memory

```js
import { createMemoryStorage } from '@itsgravix/muxload/memory-storage';
import { createExpressUploadRouter } from '@itsgravix/muxload/server';

const storage = createMemoryStorage({
  owner: (request) => request.user?.id,
  maxFileBytes: 8 * 1024 ** 2,
  maxTotalBytes: 32 * 1024 ** 2,
  maxUploads: 20,
  validate: async (request, specification) => {
    // Check metadata or application permissions before allocating memory.
  },
  finalize: async (request, upload) => {
    // upload.bytes is the complete file as a Uint8Array.
    const assetId = await yourProcessor.accept(upload.bytes);
    return { assetId }; // JSON-compatible result returned to the browser.
  },
});

app.use('/api/muxload', createExpressUploadRouter({ express, storage }));
```

`yourProcessor` is your application code. No file is written to disk by this adapter. It reserves one buffer per file and writes incoming pieces into their positions; `finalize` receives that same buffer. Treat it as read-only and copy it yourself only if your processor needs to mutate it.

The default limits are 16 MiB per file, 64 MiB of retained file buffers, and 100 upload records. These limits do not include incoming request buffers, application processing, or other runtime memory. Completed uploads stay available until removed so completion retries return the same result. Remove expired uploads through `storage.removeUpload(context, { id })` after clients no longer need them, and coordinate cleanup with active requests. Holding a reference to `upload.bytes` in your own code keeps that memory alive even after removal.

Use one upload service per adapter instance. Memory storage is temporary: server restarts lose uploads and confirmed offsets. Separate processes do not share it. For large files or persistent resume, use disk or your own persistent storage.

## Use your own filesystem, database, or byte handler

Implement these five functions and pass the object as `storage`:

```js
const storage = {
  async createUpload(context, specification) {
    // Authenticate, enforce limits, create storage and persist a record.
    // Return { id, size, offset: 0, ...yourFields }.
  },
  async resolveUpload(context, id) {
    // Load the current record and verify the caller owns it.
    // Return { id, size, offset, ...yourFields } or throw UploadHttpError.
  },
  async writePart(context, upload, bytes, offset) {
    // bytes is a Uint8Array of unchanged file data.
    // Write at offset, then persist offset + bytes.length as confirmed.
    // Resolve only once that range is safely stored.
  },
  async completeUpload(context, upload) {
    // Read/process the completed file, notify your backend, or publish it.
    // Persist and return a JSON-compatible result, e.g. { assetId }.
  },
  async removeUpload(context, upload) {
    // Remove temporary data and its upload record.
  },
};

app.use('/api/muxload', createExpressUploadRouter({ express, storage }));
```

These are callback templates: supply your storage implementation inside each function. The `context` is the Express request for this router. Fetch integrations use their configured context (the Request by default); direct service calls use whatever context you pass.

Muxload checks incoming offsets, skips already-confirmed pieces, and serializes operations for each file within one service instance. Your `resolveUpload` must return the offset persisted by `writePart`; changing an in-memory argument alone does not persist it. Store bytes before confirming them. If writing bytes succeeds but saving the offset fails, replaying the same range must be safe. Multiple processes require shared locking or transactional offset checks in your storage.

Keep `completeUpload` safe to retry, especially when notifying another backend. Use the upload ID as an idempotency key. Preserve its saved result for repeated completion calls.

You can process each piece inside `writePart`, but a one-way consumer that cannot remember confirmed offsets or tolerate replay cannot provide resumable uploads by itself. Retain enough bytes or processing state to recover after an interruption. If retaining a piece after the callback returns, copy just that piece with `bytes.slice()` to avoid retaining the entire request buffer.

## Override only one callback

All three server integrations accept callback overrides alongside `storage`:

```js
const router = createExpressUploadRouter({
  express,
  storage,
  async completeUpload(context, upload) {
    const result = await storage.completeUpload(context, upload);
    await notifyBackendOnce(upload.id, result);
    return result;
  },
});
```

`notifyBackendOnce` is your own retry-safe notification function. For disk and memory adapters, prefer their `validate` and `finalize` hooks when those cover your needs. Use full callback overrides when you need to control the storage lifecycle yourself.
