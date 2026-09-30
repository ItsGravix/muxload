# Parcelweave

Parcelweave is a JavaScript library for reliable, resumable, concurrent large-file uploads. It can upload files larger than your CDN, reverse proxy, or server's maximum request-body size by dividing each file across multiple bounded HTTP requests.

It is built to keep uploads moving on slow or unstable internet connections. Parcelweave adapts request sizes, detects real transmission stalls, retries failures, and resumes from the last server-confirmed byte instead of restarting the file. This makes it especially effective under stressful network conditions, while still allowing it to scale up and take advantage of available bandwidth when the connection is stable.

Parcelweave works with ordinary HTTP through any Node.js server, serverless and Fetch-compatible runtimes, or custom routers. Express is included as the easiest complete example. Give the browser client your upload URL and Parcelweave handles the requests, scheduling, retries, resume, and progress.

Parcelweave sends the original bytes. It does not compress, convert, base64-encode, or reduce file quality.

## Install

Install the latest version directly from GitHub:

```bash
npm install github:ItsGravix/parcelweave
```

Pin a release in production:

```bash
npm install github:ItsGravix/parcelweave#v0.18.0
```

## Optional quick start: Express

Express is optional. This example adds uploads to an Express server. For another backend, use [one request handler](docs/guides/any-backend.md) with your framework or Node's built-in HTTP server.

### 1. Server

```js
import express from "express";
import { createExpressUploadRouter, UploadHttpError } from "@itsgravix/parcelweave/server";
import { createStorageContainer } from "@itsgravix/parcelweave/storage";

const app = express();

// Parcelweave: choose where files are saved and add the upload routes.
const storage = createStorageContainer({
  directory: "./uploads",
  // Optional: check the declared filename before receiving any bytes.
  async validate(_request, file) {
    if (!file.name.toLowerCase().endsWith(".txt")) {
      throw new UploadHttpError(415, "Only .txt filenames are allowed.");
    }
  },
  // Optional: the complete file is now saved at upload.path.
  async finalize(_request, upload) {
    console.log("File received:", upload.path);
    return { id: upload.id, name: upload.name }; // Returned to the browser.
  },
});
app.use("/api/uploads", createExpressUploadRouter({ express, storage }));

app.listen(3000);
```

Already have an Express app? Add the imports, storage setup, and `app.use()` to that app. You do not need another server.

`createStorageContainer()` is an optional way to save files to disk. It creates the folder and saves one file per upload, with no metadata files beside it. You can instead supply [your own storage functions](docs/guides/custom-storage.md).

This adapter keeps resume information in memory by default. Use its `state` option with your database if uploads must survive server restarts. See the [storage guide](docs/guides/express-local-disk.md).

### 2. Browser

Add a file picker:

```html
<input id="files" type="file" multiple />
```

Use this in your frontend JavaScript with a bundler such as Vite. Load it after the input exists:

```js
import { createUploadClient } from "@itsgravix/parcelweave";

// Create once and reuse for every file. Match the server's app.use() URL.
const uploads = createUploadClient({ endpoint: "/api/uploads" });

document.querySelector("#files").addEventListener("change", (event) => {
  for (const file of event.target.files) {
    uploads.upload(file, {
      onProgress({ percentage }) {
        console.log(file.name, percentage);
      },
    }).then((result) => {
      console.log("Upload complete:", result);
    }).catch((error) => {
      console.error("Upload failed:", error);
    });
  }
});
```

The browser client handles requests, progress, retries, and resume. Your server receives and stores the bytes.

For a separate upload server, use its full URL as `endpoint` and configure CORS there. In local development, a frontend proxy can forward `/api/uploads` to Express.

## Customize what you need

- [Change URLs](docs/guides/custom-router.md): choose another base URL or rename individual routes using a shared settings object.
- [Use your own storage](docs/guides/custom-storage.md): decide where bytes go and what happens when a file finishes.
- [Validate or process files](docs/guides/express-local-disk.md): optional checks before upload and processing after it completes.
- [Read or modify file contents](docs/examples/file-handling.md): small examples using streams.
- [Use another backend](docs/guides/any-backend.md): one handler for standard requests, custom framework request objects, or plain Node.js.
- [Integrate your own router](docs/reference/upload-service.md): low-level operations for a fully custom server.

## What Parcelweave handles

- Files larger than a CDN, reverse proxy, or server's per-request body-size limit
- Slow or unstable connections through adaptive request sizes, retry, and confirmed-offset resume
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
| `createUploadClient({ endpoint, ...options })` | Upload files from the browser. Parcelweave handles the HTTP requests. |
| `createExpressUploadRouter(options)` | You want ready-made routes inside an existing Express app. |
| `createUploadHandler(options)` | Pass a request from your backend and receive a standard `Response`. |
| `createNodeUploadHandler(options)` | Connect Node's HTTP request/response objects directly (import from `/node`). |
| `createUploadService(options)` | You want to connect the protocol engine to your own router. |

## Before production

- For public or multi-user servers, add authentication and ownership checks in your application callbacks.
- If browser authentication uses cookies, reject cross-site mutation requests with CSRF tokens or strict `Origin` checks.
- Limit file sizes, request rates, active sessions, and storage use.
- Generate storage paths on the server; never trust the original filename as a path.
- Persist offsets atomically when multiple processes can receive requests.
- Keep platform and proxy body limits above your configured maximum batch size.
- Inspect completed files before publishing or processing them.
- Keep Node.js, your framework, storage SDKs, and every parser that handles completed files patched.

Parcelweave is a focused upload tool, not a replacement for every upload system. Tus, object-storage multipart uploads, or a managed service may fit some applications better.

## License

MIT
