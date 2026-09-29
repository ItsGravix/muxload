# Muxload

Muxload is a JavaScript library for reliable, resumable, chunked file uploads from web browsers to Node.js, Express, serverless functions, Fetch-compatible runtimes, or custom HTTP servers.

It is designed for large files, slow or unstable internet connections, reverse proxies such as Cloudflare, and applications that upload several files at the same time. Muxload combines small pieces from multiple files into bounded HTTP requests, reports real upload progress through `XMLHttpRequest`, retries interrupted requests, and resumes from server-confirmed byte offsets without restarting completed work.

Muxload uses ordinary HTTP requests rather than WebSockets. It sends the original bytes without compression, conversion, base64 encoding, or quality loss. Applications can use the built-in HTTP transport and Express router, a Fetch API handler, a local-disk storage adapter, custom routes, custom storage, or a completely custom transport with no endpoint configuration.

Common use cases include large audio, video, image, archive, and dataset uploads; concurrent browser uploads; uploads through Cloudflare or another reverse proxy; upload progress bars; retry and resume support; and custom JavaScript upload infrastructure where tus or managed object storage is not the right fit.

## Install

Latest version:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload
```

Pinned version for production:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload#v0.5.0
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
import { createLocalStorage } from "@itsgravix/muxload/storage";

const app = express();

const storage = createLocalStorage({
  directory: "./uploads",
  // Run your authentication middleware before the upload router.
  owner: (request) => request.user?.id,
  maxFileBytes: 2 * 1024 ** 3,
});

app.use("/api/muxload", createExpressUploadRouter({
  express,
  storage,
}));

app.listen(3000);
```

The router creates all required Muxload routes. Your application still controls the server, authentication, and storage.

The disk adapter creates files, stores upload records, verifies ownership, writes pieces, and records completion. Files are saved as `uploads/<id>/data`; the original filename is kept in the record. Use one service instance per directory in a single Node.js process. This adapter requires a persistent local filesystem.

Optional `validate(context, specification)` and `finalize(context, upload)` hooks let you check a file before accepting it and process it after completion. `finalize` receives `upload.path`; its JSON-compatible return value is returned to the browser. Make external effects in this hook idempotent: a crash before the result is saved can cause it to run again. Completed files stay on disk until your application removes them; schedule cleanup for abandoned uploads.

All server integrations accept `{ storage }`. You can supply your own adapter or override any individual callback alongside it.

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

You only need these when using custom storage. The local-disk adapter implements them for you.

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

## Use your own sending code

No endpoint is required when you supply a transport. A transport is an object with five methods that send data using your own API, RPC client, or in-process service:

```js
const uploads = createUploadClient({
  transport: {
    create: (specification, { signal }) => myApi.create(specification, signal),
    batch: (pieces, { onProgress }) => myApi.sendPieces(pieces, onProgress),
    status: (ids) => myApi.status(ids),
    complete: (id) => myApi.complete(id),
    remove: (id) => myApi.remove(id),
  },
});
```

Each method returns a promise. `create` returns `{ id, offset }`. `batch` receives an array of `{ id, offset, length, blob }` pieces and returns `{ offsets: { [id]: savedBytes } }`; `status` returns the same offset shape. `complete` returns your result, and `remove` needs no result. Progress is cumulative payload bytes for the current batch, in piece order, excluding headers. Muxload still handles scheduling and retry decisions.

Throw `new UploadError(message, { retryable: true })` from `@itsgravix/muxload` for temporary failures. Other errors stop the affected uploads. Custom transports must settle every operation, including failures and stalls; the default HTTP transport supplies its own watchdogs. Sending unchanged pieces to the server engine is easy with `encodeBatch(pieces)` from `@itsgravix/muxload/protocol`.

To customize just one HTTP operation, wrap the built-in transport:

```js
import { createHttpTransport, createUploadClient } from "@itsgravix/muxload";

const http = createHttpTransport({ endpoint: "/api/muxload" });
const uploads = createUploadClient({
  transport: { ...http, complete: (id) => myApi.finish(id) },
});
```

## Pause, resume, cancel, and events

`onProgress` includes the upload `id`. Use it with `uploads.pause(id)`, `uploads.resume(id)`, or `uploads.cancel(id)`. Pause waits for the current batch to settle so other files in that batch can continue. Finalization cannot be paused. Resume keeps the file and its confirmed offset in the current client; this does not restore a browser session after a page reload.

You can also pass an `AbortSignal` to `upload(file, { signal })` to cancel that file. Cancellation leaves shared requests intact and rejects the upload promise with `AbortError` after cleanup is attempted.

Set `onEvent(event)` on the client to observe `created`, `retry`, `error`, `paused`, `resumed`, `cancelled`, and `complete` events. Events contain the upload ID and, where applicable, the error or completion result.

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
