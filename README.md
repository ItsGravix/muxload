# Muxload

Muxload makes large browser uploads resumable and lets several files share bounded HTTP requests fairly. It uses normal HTTP and never changes or compresses file bytes.

Muxload does **not** start or host a web server. It gives you:

- a browser upload client;
- a portable upload engine for your existing backend;
- optional adapters for common server styles.

## Install

Install the latest default branch:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload
```

For a repeatable production build, pin a release:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload#v0.4.0
```

The unpinned command checks the latest branch when npm resolves the dependency. An existing lockfile does not update automatically.

## Browser quick start

```js
import { createUploadClient } from "@itsgravix/muxload";

const uploads = createUploadClient({
  endpoint: "/api/muxload",
});

const result = await uploads.upload(file, {
  metadata: { kind: "audio" },
  onProgress({ percentage }) {
    console.log(`${percentage}%`);
  },
});
```

Use one client instance for the whole page. Every call to `upload()` joins the same fair scheduler, including files added after an upload has started.

The endpoint may also be on another domain:

```js
const uploads = createUploadClient({
  endpoint: "https://uploads.example.com/v1",
  credentials: "include",
  headers: async () => ({
    Authorization: `Bearer ${await getAccessToken()}`,
  }),
});
```

Configure CORS on the remote service. The optional `prepare` callback can perform one-time application setup, but Muxload does not require a separate session endpoint.

## Choose a server integration

You provide five application-specific operations:

- create an upload record and destination;
- find an upload by ID and verify ownership;
- write bytes at an offset;
- finalize a completed upload;
- remove a cancelled upload.

Muxload handles the complicated parts around them: routes, request limits, binary decoding, offset validation, per-file locking, duplicate requests, resumable status responses, and error responses.

### Option 1: Express

Use this when the application already runs Express:

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

Muxload creates the routes inside the router. Your existing application still owns and starts the server.

### Option 2: serverless or Fetch-compatible runtime

Use the standard `Request → Response` handler with Workers, functions, or Fetch-compatible servers:

```js
import { createFetchUploadHandler } from "@itsgravix/muxload/server";

const handleUpload = createFetchUploadHandler({
  basePath: "/v1",
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

Muxload does not open a port here. The hosting platform invokes the returned handler.

### Option 3: custom server or custom routes

Use the framework-neutral service inside an existing server:

```js
import { createUploadService } from "@itsgravix/muxload/server";

const mux = createUploadService({
  createUpload,
  resolveUpload,
  writePart,
  completeUpload,
  removeUpload,
});

customServer.post("/files/new", async (request, response) => {
  response.json(await mux.create(request, request.body), 201);
});

customServer.post("/files/data", async (request, response) => {
  response.json(await mux.batch(request, request.rawBody));
});
```

The remaining operations are:

```js
await mux.status(context, ids);
await mux.complete(context, uploadId);
await mux.remove(context, uploadId);
```

Tell the browser client about custom route names:

```js
const uploads = createUploadClient({
  endpoint: "/api",
  routes: {
    create: "files/new",
    batch: "files/data",
    status: (ids) => `files/progress?ids=${ids.map(encodeURIComponent).join(",")}`,
    complete: (id) => `files/${encodeURIComponent(id)}/finish`,
    remove: (id) => `files/${encodeURIComponent(id)}`,
  },
});
```

Route values can be absolute URLs, so individual operations may live in different services or functions. Users do not need to fork Muxload to control routing or storage behavior.

## Callback shape

The same callbacks work with every server integration:

```js
const callbacks = {
  async createUpload(context, specification) {
    // Authenticate, enforce quotas, and create the destination.
    return { id: "random-id", size: specification.size, offset: 0 };
  },

  async resolveUpload(context, id) {
    // Authenticate and verify that this caller owns the ID.
    return upload; // Must contain { id, size, offset }.
  },

  async writePart(context, upload, bytes, offset) {
    // Write these unchanged bytes at this exact offset.
  },

  async completeUpload(context, upload) {
    // Validate, move, publish, or enqueue the completed file.
    return { id: upload.id, complete: true };
  },

  async removeUpload(context, upload) {
    // Remove temporary data and the upload record.
  },
};
```

Throw `UploadHttpError` when an application error needs a specific public status and message:

```js
import { UploadHttpError } from "@itsgravix/muxload/server";

throw new UploadHttpError(404, "Upload not found.");
```

## How it works

Muxload starts with small 128 KiB batches. One batch may contain pieces from several logical files. Successful fast requests allow the batch size and physical concurrency to grow; failures reduce them. Concurrent requests never contain pieces from the same file.

Every file keeps its own server-confirmed offset. After an uncertain failure, the client asks the server for current offsets and resends only unconfirmed bytes. Displayed progress never moves backward and stays below 100% until the server confirms completion.

If 20 files cannot fit in one request, Muxload rotates through smaller groups over later requests. The browser works with bounded `Blob.slice()` pieces rather than copying complete files into JavaScript memory.

## Default HTTP routes

The standard client, Fetch handler, and Express adapter use:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/uploads` | Create a logical upload. |
| `POST` | `/batches` | Send bounded pieces from one or more files. |
| `GET` | `/status?ids=...` | Read confirmed offsets after an uncertain result. |
| `POST` | `/uploads/:id/complete` | Finalize a fully received file. |
| `DELETE` | `/uploads/:id` | Cancel and clean up one upload. |

These are protocol defaults, not a requirement to run a traditional public web server.

## Production checklist

- Authenticate every operation and bind each upload ID to its owner.
- Generate storage paths server-side; never use a supplied filename as a path.
- Apply rate, session-count, total-size, storage, and expiry limits.
- Inspect completed files before publishing or processing them.
- Keep proxy and platform body limits above the configured maximum batch size.
- Use durable upload records and storage when requests may reach different processes.
- Configure CORS carefully for cross-origin endpoints.

Muxload is a focused solution, not a replacement for tus, object-storage multipart uploads, or a managed upload service. Prefer those when they fit the application better.

## License

MIT
