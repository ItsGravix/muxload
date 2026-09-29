# Muxload

Reliable, resumable browser uploads using normal HTTP requests. Muxload supports several files at once and never compresses or changes their bytes.

## Install

Latest version:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload
```

Pinned version for production:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload#v0.4.2
```

## Browser

Create one client and reuse it for every file:

```js
import { createUploadClient } from "@itsgravix/muxload";

const uploads = createUploadClient({
  endpoint: "/api/muxload",
});

await uploads.upload(file, {
  metadata: { kind: "audio" },
  onProgress({ percentage }) {
    console.log(`${percentage}%`);
  },
});
```

Every `upload()` call joins the same scheduler. Files can be added while other files are already uploading.

## Server

Muxload does not start or host a web server. Add it to the server you already use.

Choose the example that matches your project:

- [Express router](#express)
- [Serverless or Fetch handler](#serverless-or-fetch)
- [Your own router](#your-own-router)

### Express

```js
import express from "express";
import { createExpressUploadRouter } from "@itsgravix/muxload/server";

const app = express();

app.use("/api/muxload", createExpressUploadRouter({
  express,
  createUpload,
  resolveUpload,
  writePart,
  completeUpload,
  removeUpload,
}));

app.listen(3000);
```

The router creates all required Muxload routes. Your application still controls the server, authentication, and storage.

### Serverless or Fetch

For Workers, serverless platforms, or frameworks using standard `Request` and `Response` objects:

```js
import { createFetchUploadHandler } from "@itsgravix/muxload/server";

const handleUpload = createFetchUploadHandler({
  basePath: "/api/muxload",
  createUpload,
  resolveUpload,
  writePart,
  completeUpload,
  removeUpload,
});

export default {
  fetch(request) {
    return handleUpload(request);
  },
};
```

Your platform calls this function. Muxload does not open a port.

### Your own router

If you cannot mount a complete router, connect each route manually:

```js
import { createUploadService } from "@itsgravix/muxload/server";

const mux = createUploadService({
  createUpload,
  resolveUpload,
  writePart,
  completeUpload,
  removeUpload,
});

router.post("/files/new", async (req, res) => {
  res.status(201).json(await mux.create(req, req.body));
});

router.post("/files/data", async (req, res) => {
  res.json(await mux.batch(req, req.rawBody));
});

router.get("/files/status", async (req, res) => {
  res.json(await mux.status(req, req.query.ids.split(",")));
});

router.post("/files/:id/complete", async (req, res) => {
  res.json(await mux.complete(req, req.params.id));
});

router.delete("/files/:id", async (req, res) => {
  await mux.remove(req, req.params.id);
  res.status(204).end();
});
```

The `/files/data` route must pass the raw binary body to `mux.batch()`. Do not parse that request as JSON or text.

Tell the browser about your route names:

```js
const uploads = createUploadClient({
  endpoint: "/api",
  routes: {
    create: "files/new",
    batch: "files/data",
    status: (ids) => `files/status?ids=${ids.map(encodeURIComponent).join(",")}`,
    complete: (id) => `files/${encodeURIComponent(id)}/complete`,
    remove: (id) => `files/${encodeURIComponent(id)}`,
  },
});
```

Route values can also be complete URLs. This lets each operation use a different service or serverless function.

## Storage callbacks

Every server option uses the same five callbacks:

| Callback | What your code does |
| --- | --- |
| `createUpload(context, specification)` | Authenticate the user, create an upload record, and return `{ id, size, offset }`. |
| `resolveUpload(context, id)` | Load the record, verify ownership, and return `{ id, size, offset }`. |
| `writePart(context, upload, bytes, offset)` | Write the unchanged bytes at the given position. |
| `completeUpload(context, upload)` | Validate or publish the completed file and return your result. |
| `removeUpload(context, upload)` | Remove temporary bytes and the upload record. |

Muxload handles request decoding, size checks, offsets, duplicate pieces, retries, and responses around these callbacks.

For application errors, throw `UploadHttpError`:

```js
import { UploadHttpError } from "@itsgravix/muxload/server";

throw new UploadHttpError(404, "Upload not found.");
```

The Express and Fetch adapters format this error automatically. A custom router should catch it and use its `status`, `message`, and optional `details` fields.

## Separate serverless functions

You can call one service method from each function. For example, the function receiving file data calls `mux.batch()` while another function calls `mux.complete()`.

Store upload records and offsets in durable storage, not an in-memory `Map`. Different requests may run on different machines. Your storage must also protect offset updates with a transaction, conditional write, or another atomic operation.

## Uploading to another domain

```js
const uploads = createUploadClient({
  endpoint: "https://uploads.example.com/v1",
  credentials: "include",
  headers: async () => ({
    Authorization: `Bearer ${await getAccessToken()}`,
  }),
});
```

Allow your website's origin, HTTP methods, `Content-Type`, and authentication headers in the upload service's CORS settings.

## What Muxload handles

- Resumable pieces and confirmed offsets
- Several files sharing bounded requests fairly
- Retries after interrupted or uncertain requests
- Upload progress that does not move backward
- Adaptive request size and concurrency
- Bounded browser memory using `Blob.slice()`
- Per-file locking inside one server instance

## Before production

- Authenticate every operation and verify upload ownership.
- Limit file sizes, request rates, active sessions, and storage use.
- Generate storage paths on the server; never trust the original filename as a path.
- Persist confirmed offsets atomically when multiple processes can receive requests.
- Keep platform and proxy body limits above Muxload's maximum batch size.
- Inspect completed files before publishing or processing them.

Muxload is a focused upload tool. Tus, object-storage multipart uploads, or a managed upload service may be a better choice for some applications.

## License

MIT
