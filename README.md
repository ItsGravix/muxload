# Muxload

Muxload uploads pieces of several files in one bounded HTTP request. It is built for unreliable or highly variable connections where a long request is risky, but treating every file as a separate competing upload is also undesirable.

It uses ordinary `POST` requests. There are no WebSockets and no full-file copies in application memory. A browser request contains a small manifest followed by bounded `Blob.slice()` pieces from several files.

> Muxload is a focused solution, not a replacement for mature upload systems such as tus, object-storage multipart uploads, or a managed upload service. Use those when they fit your infrastructure.

## What it does

- Adds new files to the next request without changing a request already in flight.
- Rotates fairly through any number of logical uploads.
- Caps the bytes and files in every physical request.
- Tracks a separate server-confirmed offset for every file.
- Reconciles offsets after ambiguous failures, then resends only unconfirmed pieces.
- Starts with conservative 128 KiB batches, grows after repeated fast successes, and shrinks after failures.
- Can cautiously add physical request concurrency on fast connections. Concurrent requests use disjoint files.
- Reports smooth XHR byte progress without allowing the displayed value to move backward.
- Treats byte inactivity and response inactivity separately, with deliberately long defaults.

## Browser

Install the latest code from the default GitHub branch:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload
```

For repeatable production builds, pin a release instead:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload#v0.2.0
```

The unpinned command fetches the latest default branch when npm resolves the dependency. It does not automatically update an existing lockfile; run the install command again to update. A pinned tag is safer for applications.

```js
import { createUploadClient } from "@itsgravix/muxload";

const uploads = createUploadClient({
  endpoint: "/api/uploads",
});

const result = await uploads.upload(file, {
  metadata: { kind: "audio" },
  onProgress({ percentage, bytesConfirmed }) {
    console.log(percentage, bytesConfirmed);
  },
});
```

Call `upload()` again at any time. All calls share the same scheduler and new files join later batches.

`endpoint` is the base URL of any HTTP service that implements the Muxload contract. It can be same-origin, an absolute URL on another domain, a serverless function gateway, a container, or another language entirely. Express is only the included reference adapter.

For a cross-origin service or token-based authentication:

```js
const uploads = createUploadClient({
  endpoint: "https://uploads.example.com/v1",
  credentials: "include", // Send cross-origin cookies when the server permits it.
  headers: async () => ({
    Authorization: `Bearer ${await getAccessToken()}`,
  }),
});
```

Configure CORS on that service for your website's origin, methods, and headers. `prepare` is an optional application hook for one-time setup such as creating a cookie-backed session; Muxload itself does not require a separate session endpoint.

## HTTP contract

The client communicates with five ordinary HTTP routes beneath `endpoint`:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/uploads` | Create one logical upload and return its ID and confirmed offset. |
| `POST` | `/batches` | Accept one bounded Muxload body containing pieces from one or more files. |
| `GET` | `/status?ids=...` | Return confirmed offsets after an uncertain result. |
| `POST` | `/uploads/:id/complete` | Validate and finalize a completely received file. |
| `DELETE` | `/uploads/:id` | Cancel and clean up one logical upload. |

The route names are an HTTP protocol contract, not a requirement to run a traditional public web server. A gateway can map them to functions, workers, object storage, queues, or any other backend. See `src/server.js` for the request validation and response shapes.

## Optional Express adapter

Muxload deliberately leaves storage, authentication, ownership, and final validation to the application:

```js
import express from "express";
import { open } from "node:fs/promises";
import { createExpressUploadRouter, UploadHttpError } from "@itsgravix/muxload/server";

const sessions = new Map();
const app = express();

app.use("/api/uploads", createExpressUploadRouter({
  express,
  maxBatchBytes: 4 * 1024 * 1024,
  async createUpload(req, spec) {
    // Authenticate first; create an empty temp file; never trust spec.name as a path.
    const upload = { id: crypto.randomUUID(), size: spec.size, offset: 0, path: safeTempPath() };
    sessions.set(upload.id, upload);
    return upload;
  },
  async resolveUpload(req, id) {
    const upload = sessions.get(id);
    if (!upload) throw new UploadHttpError(404, "Upload not found.");
    return upload;
  },
  async writePart(req, upload, bytes, offset) {
    const file = await open(upload.path, "r+");
    try { await file.write(bytes, 0, bytes.length, offset); }
    finally { await file.close(); }
  },
  async completeUpload(req, upload) {
    // Inspect and commit the completed file here.
    return { id: upload.id, complete: true };
  },
  async removeUpload(req, upload) {
    sessions.delete(upload.id);
    // Remove its temporary file here.
  },
}));
```

## Limits and memory

`maxBatchBytes` limits payload bytes, while `maxFilesPerBatch` limits how many files contribute to one request. If 20 files cannot fit, Muxload sends several requests and rotates the selected files. It does not need a request large enough to hold a piece from every active file.

The browser constructs a bounded `Blob` from file slices. It does not read or duplicate whole files in JavaScript memory. The Express adapter buffers one bounded request body so it can validate the complete manifest before committing pieces. Account for `maxBatchBytes × physical concurrency` when choosing limits.

## Security checklist

- Authenticate every create, batch, status, completion, and deletion request.
- Bind every upload id to its owner in `resolveUpload`.
- Generate storage paths server-side; never use the supplied filename as a path.
- Apply request-rate, session-count, total-size, and expiry limits in the application.
- Inspect completed files before publishing or processing them.
- Keep proxy and server body limits above Muxload's maximum encoded batch size.

## License

MIT
