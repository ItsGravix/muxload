# Muxload

Muxload helps browsers upload large files over slow or unreliable connections.

It can upload several files fairly, retry failed pieces, and continue from the last bytes confirmed by your server. It uses normal HTTP requests. It does not compress, convert, or change the files.

## The simple mental model

Muxload has two sides:

```text
Browser client  →  your HTTP endpoint  →  your storage
```

- The **browser client** splits files into small pieces and sends them.
- The **server engine** checks each piece and tracks where every file continues.
- **Your application** decides who may upload and where the bytes are stored.

Muxload does not create a website, open a port, or start a server. It plugs into the server or hosting platform you already use.

## Install

Install the newest code from GitHub:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload
```

For production, pin a version so future changes cannot install unexpectedly:

```bash
npm install @itsgravix/muxload@github:ItsGravix/muxload#v0.4.1
```

The unpinned command checks the newest default branch when npm resolves the dependency. A lockfile will keep its currently resolved commit until you update the dependency again.

## Browser setup

Create one client and reuse it for every file on the page:

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

Calling `upload()` again adds another file to the same scheduler. A file selected later joins a later request; Muxload never tries to modify a request that is already being sent.

## Pick one server setup

| Your situation | Use |
| --- | --- |
| You use Express and want Muxload to add its routes | `createExpressUploadRouter` |
| Your platform accepts standard `Request` objects | `createFetchUploadHandler` |
| You already have your own router or URL design | `createUploadService` |
| Each route is a separate serverless function | `createUploadService` inside each function |

All three choices use the same upload engine. The difference is only how incoming HTTP requests reach it.

## Option 1: Express router

This is the shortest server setup. Muxload creates an Express router, but your application still owns and starts Express.

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

The browser endpoint and Express mount path must match:

```js
createUploadClient({ endpoint: "/api/muxload" });
```

## Option 2: one Fetch-compatible handler

Use this with a Worker, serverless gateway, or framework that works with standard Web API `Request` and `Response` objects:

```js
import { createFetchUploadHandler } from "@itsgravix/muxload/server";

const handleMuxload = createFetchUploadHandler({
  basePath: "/uploads",
  createUpload,
  resolveUpload,
  writePart,
  completeUpload,
  removeUpload,
});

export default {
  fetch(request) {
    return handleMuxload(request);
  },
};
```

This function does not start a server. Your platform calls it whenever a request arrives.

If the same application handles other URLs, route only the Muxload prefix to it:

```js
export default {
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/uploads/")) return handleMuxload(request);
    return handleTheRestOfTheApplication(request);
  },
};
```

## Option 3: your own router

Some applications cannot mount one router or send every upload route to one function. Use `createUploadService` to call the Muxload operations yourself.

```js
import {
  createUploadService,
  UploadHttpError,
} from "@itsgravix/muxload/server";

const mux = createUploadService({
  createUpload,
  resolveUpload,
  writePart,
  completeUpload,
  removeUpload,
});
```

The service gives your router five methods:

```js
mux.create(context, specification);
mux.batch(context, rawRequestBytes);
mux.status(context, uploadIds);
mux.complete(context, uploadId);
mux.remove(context, uploadId);
```

`context` can be your request object, authenticated user, function context, or another value your callbacks need.

### Example custom routes

The exact router syntax will differ, but the mapping looks like this:

```js
router.post("/files/new", async (request, response) => {
  const result = await mux.create(request, request.jsonBody);
  response.status(201).json(result);
});

router.post("/files/data", async (request, response) => {
  const result = await mux.batch(request, request.rawBody);
  response.json(result);
});

router.get("/files/progress", async (request, response) => {
  const ids = request.query.ids.split(",");
  response.json(await mux.status(request, ids));
});

router.post("/files/:id/finish", async (request, response) => {
  response.json(await mux.complete(request, request.params.id));
});

router.delete("/files/:id", async (request, response) => {
  await mux.remove(request, request.params.id);
  response.status(204).end();
});
```

Important: the batch route must provide the **raw binary request body** to `mux.batch()`. Do not run that body through a JSON or text parser.

### Tell the browser about custom routes

The browser does not need the default route names:

```js
const uploads = createUploadClient({
  endpoint: "/api",
  routes: {
    create: "files/new",
    batch: "files/data",
    status: (ids) =>
      `files/progress?ids=${ids.map(encodeURIComponent).join(",")}`,
    complete: (id) =>
      `files/${encodeURIComponent(id)}/finish`,
    remove: (id) =>
      `files/${encodeURIComponent(id)}`,
  },
});
```

Each route may also be a complete URL. This allows different operations to live in separate functions or services:

```js
routes: {
  create: "https://create.example.com/upload",
  batch: "https://data.example.com/upload",
  status: (ids) =>
    `https://status.example.com/upload?ids=${ids.join(",")}`,
  complete: (id) =>
    `https://finish.example.com/upload/${id}`,
  remove: (id) =>
    `https://delete.example.com/upload/${id}`,
}
```

## Separate serverless functions

If every HTTP route deploys as a different function, create the same service inside each function and call only the required method:

```js
// The function responsible for batch data.
const mux = createUploadService(callbacks);

export async function handleBatch(request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const result = await mux.batch(request, bytes);
  return Response.json(result);
}
```

In this setup, never depend on an in-memory `Map` for upload records. Separate invocations may run on different machines. Store upload IDs, sizes, owners, and confirmed offsets in durable storage such as a database, durable object, or transactional metadata store.

Concurrent writes also need storage-level protection. Muxload prevents conflicting writes inside one running service instance, but it cannot lock two unrelated machines. Use conditional updates, transactions, object-store multipart rules, or another atomic storage mechanism.

## What your five callbacks do

Muxload handles the protocol. Your callbacks connect it to authentication and storage.

```js
const callbacks = {
  async createUpload(context, specification) {
    // Authenticate, enforce limits, and create the destination.
    return {
      id: crypto.randomUUID(),
      size: specification.size,
      offset: 0,
    };
  },

  async resolveUpload(context, id) {
    // Load the record and verify that this caller owns it.
    return upload; // Must include { id, size, offset }.
  },

  async writePart(context, upload, bytes, offset) {
    // Write these unchanged bytes at this exact position.
  },

  async completeUpload(context, upload) {
    // Validate, move, publish, or enqueue the finished file.
    return { id: upload.id, complete: true };
  },

  async removeUpload(context, upload) {
    // Remove temporary bytes and the upload record.
  },
};
```

Muxload updates the returned upload object's `offset` after a successful write. If `resolveUpload` loads a fresh object from a database on every request, `writePart` must also persist the new confirmed offset atomically with the bytes.

## Errors in a custom router

The ready-made Express and Fetch adapters format errors for you. A custom router should catch `UploadHttpError`:

```js
try {
  response.json(await mux.complete(request, uploadId));
} catch (error) {
  if (error instanceof UploadHttpError) {
    response.status(error.status).json({
      error: error.message,
      ...error.details,
    });
  } else {
    console.error(error);
    response.status(500).json({ error: "Upload failed." });
  }
}
```

Do not return internal stack traces or storage errors to the browser.

## Cross-origin endpoints

For an upload service on another domain:

```js
const uploads = createUploadClient({
  endpoint: "https://uploads.example.com/v1",
  credentials: "include",
  headers: async () => ({
    Authorization: `Bearer ${await getAccessToken()}`,
  }),
});
```

Configure CORS to allow your website's origin, the required methods, `Content-Type`, and any authentication headers. Handle `OPTIONS` preflight requests in your platform or router.

## What Muxload handles

- Fairly rotates through any number of logical files.
- Keeps every physical request below a configured size.
- Starts with conservative 128 KiB batches and adapts after successes or failures.
- Keeps simultaneous physical requests away from the same logical file.
- Tracks a separate confirmed offset for every file.
- Reconciles offsets after uncertain failures.
- Makes repeated confirmed pieces safe instead of duplicating bytes.
- Reports XHR upload progress without allowing the visible percentage to move backward.
- Uses bounded `Blob.slice()` pieces rather than copying complete files in JavaScript memory.

## Default routes

The ready-made client and adapters use these paths unless `routes` is configured:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/uploads` | Create an upload. |
| `POST` | `/batches` | Send pieces from one or more files. |
| `GET` | `/status?ids=...` | Read confirmed offsets. |
| `POST` | `/uploads/:id/complete` | Finalize a complete file. |
| `DELETE` | `/uploads/:id` | Cancel and remove an upload. |

## Production checklist

- Authenticate every operation.
- Verify ownership whenever an upload ID is used.
- Generate storage paths on the server; never trust a filename as a path.
- Limit file sizes, active sessions, request rates, storage use, and session age.
- Keep proxy and platform body limits above Muxload's maximum batch size.
- Use durable metadata and atomic offset updates across multiple processes.
- Inspect completed files before publishing or processing them.
- Configure CORS narrowly when the upload endpoint is cross-origin.

Muxload is a focused solution, not a replacement for tus, object-storage multipart uploads, or a managed upload service. Prefer those when they fit your application better.

## License

MIT
