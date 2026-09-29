# Muxload

Muxload is a JavaScript library for reliable, resumable, concurrent large-file uploads. It multiplexes pieces from several files into bounded requests, reports real browser upload progress, retries interruptions, and resumes from server-confirmed offsets.

It works with ordinary HTTP through Node.js, Express, serverless and Fetch-compatible runtimes, but the core scheduler is transport-neutral. You can replace the HTTP layer with your own API or in-process integration without changing Muxload's scheduling logic.

Muxload sends the original bytes. It does not compress, convert, base64-encode, or reduce file quality.

## Install

Install the latest version directly from GitHub:

```bash
npm install github:ItsGravix/muxload
```

Pin a release in production:

```bash
npm install github:ItsGravix/muxload#v0.6.0
```

## Easy HTTP setup

If your browser sends files to one upload route, use the convenience helper:

```js
import { createHttpUploadClient } from "@itsgravix/muxload";

const uploads = createHttpUploadClient({ endpoint: "/api/muxload" });

await uploads.upload(file, {
  metadata: { kind: "audio" },
  onProgress({ percentage }) {
    console.log(`${percentage}%`);
  },
});
```

The endpoint is only an HTTP setting. `createHttpUploadClient()` combines the reusable upload scheduler with Muxload's built-in HTTP transport.

On an Express server, mount the matching router:

```js
import express from "express";
import { createExpressUploadRouter } from "@itsgravix/muxload/server";
import { createLocalStorage } from "@itsgravix/muxload/storage";

const app = express();
const storage = createLocalStorage({
  directory: "./uploads",
  owner: (request) => request.user.id,
});

app.use("/api/muxload", createExpressUploadRouter({ express, storage }));
app.listen(3000);
```

Muxload adds routes to your existing server; it does not start or host a server itself.

## More control

Configure the HTTP layer separately when you need custom URLs, headers, authentication, or a partly customized transport:

```js
import { createHttpTransport, createUploadClient } from "@itsgravix/muxload";

const transport = createHttpTransport({
  endpoint: "https://uploads.example.com/v1",
  credentials: "include",
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
});

const uploads = createUploadClient({ transport, maxConcurrentRequests: 3 });
```

For a completely custom integration, provide five transport methods. No endpoint is involved:

```js
const uploads = createUploadClient({
  transport: {
    create: (specification, options) => myApi.create(specification, options),
    batch: (pieces, options) => myApi.sendPieces(pieces, options),
    status: (ids) => myApi.status(ids),
    complete: (id) => myApi.complete(id),
    remove: (id) => myApi.remove(id),
  },
});
```

Choose the guide that matches your application:

- [Express and local disk](docs/guides/express-local-disk.md) — the shortest complete setup.
- [Custom routes and servers](docs/guides/custom-router.md) — connect Muxload to an existing router or unusual URL layout.
- [Serverless and Fetch runtimes](docs/guides/serverless-fetch.md) — use standard `Request` and `Response` objects.
- [Custom transports](docs/guides/custom-transport.md) — use your own networking or endpoint-free integration.

## What Muxload handles

- Several files sharing bounded requests fairly, including files added later
- Retry and resume from server-confirmed byte offsets
- Upload progress that does not move backward
- Adaptive request size and concurrency
- Bounded browser memory through `Blob.slice()`
- Pause, resume, cancellation, and lifecycle events

Create one client and reuse it for every file. Every `upload()` call joins the same scheduler. Use `uploads.pause(id)`, `uploads.resume(id)`, and `uploads.cancel(id)` for individual uploads.

## API choices

| API | Use it when |
| --- | --- |
| `createHttpUploadClient(options)` | You want the simplest browser-to-HTTP setup. Requires `endpoint`. |
| `createHttpTransport(options)` | You want to configure or extend the built-in HTTP behavior separately. |
| `createUploadClient({ transport, ...options })` | You want direct control over how operations are sent. It never assumes an endpoint. |
| `createExpressUploadRouter(options)` | You want ready-made routes inside an existing Express app. |
| `createFetchUploadHandler(options)` | Your runtime uses web-standard `Request` and `Response`. |
| `createUploadService(options)` | You want to connect the protocol engine to your own router. |

## Before production

- Authenticate every operation and verify upload ownership.
- Limit file sizes, request rates, active sessions, and storage use.
- Generate storage paths on the server; never trust the original filename as a path.
- Persist offsets atomically when multiple processes can receive requests.
- Keep platform and proxy body limits above your configured maximum batch size.
- Inspect completed files before publishing or processing them.

Muxload is a focused upload tool, not a replacement for every upload system. Tus, object-storage multipart uploads, or a managed service may fit some applications better.

## License

MIT
