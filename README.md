# Parcelweave

Parcelweave is a JavaScript library for reliable, resumable, concurrent large-file uploads. It can upload files larger than your CDN, reverse proxy, or server's maximum request-body size by dividing each file across multiple bounded HTTP requests.

It is built to keep uploads moving on slow or unstable internet connections. Parcelweave adapts request sizes, detects real transmission stalls, retries failures, and resumes from the last server-confirmed byte instead of restarting the file. This makes it especially effective under stressful network conditions, while still allowing it to scale up and take advantage of available bandwidth when the connection is stable.

Parcelweave works with ordinary HTTP through any Node.js server, serverless and Fetch-compatible runtimes, custom routers, or your own transport. Express is included as the easiest complete example. The core scheduler is transport-neutral, so you can replace the HTTP layer with your own API or in-process integration without changing Parcelweave's scheduling logic.

Parcelweave sends the original bytes. It does not compress, convert, base64-encode, or reduce file quality.

## Install

Install the latest version directly from GitHub:

```bash
npm install github:ItsGravix/parcelweave
```

Pin a release in production:

```bash
npm install github:ItsGravix/parcelweave#v0.11.0
```

## Optional quick start: Express

This section shows one ready-made setup if you use Express. It is not required to use Parcelweave. For another server or infrastructure, go to the [custom server guide](docs/guides/custom-router.md), [Fetch and serverless guide](docs/guides/serverless-fetch.md), or [custom transport guide](docs/guides/custom-transport.md).


### 1. Add uploads to your Express server

If you already have an Express app, add the imports near the top of your server file and mount the router. This quick start uses Parcelweave's optional local-disk adapter; you can replace it with your own storage functions.

```js
import express from "express";

// Parcelweave imports.
import { createExpressUploadRouter } from "@itsgravix/parcelweave/server";
import { createLocalStorage } from "@itsgravix/parcelweave/storage";

// Parcelweave setup starts here. This local-disk adapter is optional.
const storage = createLocalStorage({
  directory: "./uploads", // The adapter creates this folder automatically.
});

app.use("/api/uploads", createExpressUploadRouter({ express, storage }));
// Parcelweave setup ends here.
```

Here is the same setup as a complete server:

```js
import express from "express";

// Parcelweave imports.
import { createExpressUploadRouter, UploadHttpError } from "@itsgravix/parcelweave/server";
import { createLocalStorage } from "@itsgravix/parcelweave/storage";

// Your normal Express setup.
const app = express();
app.use(express.json());

// Your normal application routes can come before or after Parcelweave.
app.get("/", (request, response) => response.send("Server is running"));

// Parcelweave setup starts here. This local-disk adapter is optional.
const storage = createLocalStorage({
  directory: "./uploads", // Created automatically when the first upload starts.
  maxFileBytes: 2 * 1024 ** 3, // Optional: 2 GiB per file.
  // Optional: runs once before Parcelweave accepts any file bytes.
  validate: async (_request, uploadInfo) => {
    if (!uploadInfo.name.toLowerCase().endsWith(".txt")) {
      throw new UploadHttpError(415, "Only text files are allowed.");
    }
  },
  // Optional: finalize() runs after the complete file has been received.
  finalize: async (_request, upload) => {
    // The full file is now saved at upload.path.
    console.log("Upload received:", upload.name);
    // Return the information your browser needs.
    return { id: upload.id, name: upload.name };
  },
});

// Add this alongside your other API routes.
app.use("/api/uploads", createExpressUploadRouter({ express, storage }));
// Parcelweave setup ends here.

app.listen(3000, () => {
  console.log("Server listening on http://localhost:3000");
});
```

Folder creation is an optional feature provided by `createLocalStorage()`. If you choose this adapter, give it one base directory, such as `./uploads`; it automatically creates that directory and a separate subfolder for every accepted upload. The file bytes are saved at `uploads/<upload-id>/data`, while Parcelweave's upload record is kept beside them. You do not need to create these folders yourself. The `validate` and `finalize` options are optional.

`validate(request, uploadInfo)` runs once when the browser asks to start an upload—before the upload directory is created and before Parcelweave accepts the first byte. `uploadInfo` contains the client-declared `name`, `size`, and `metadata`, so this hook is useful for limits, permissions, and preliminary checks. It does not receive file contents. Inspect actual bytes in `finalize()` after the complete file arrives, or provide a custom `writePart()` if you need incremental inspection while pieces arrive.

Use `createLocalStorage()` when saving uploads this way fits your application. If you want object storage, a different filesystem layout, or another destination, skip `createLocalStorage()` and pass your own `createUpload`, `resolveUpload`, `writePart`, `completeUpload`, and `removeUpload` functions to the router. See the [custom byte handler guide](docs/guides/custom-storage.md) for a complete example.

The local storage adapter uses random upload IDs and accepts requests that know the corresponding ID. If your server is public or multi-user, implement authorization in custom callbacks as shown in the [custom byte handler guide](docs/guides/custom-storage.md).

`app.use("/api/uploads", ...)` adds the upload routes at that URL. You may choose any path; use the same value in the browser client's `endpoint` option.

For reading or changing file contents, see the [file handling examples](docs/examples/file-handling.md).

### 2. Send files from your browser

Add a file picker to your page:

```html
<input id="files" type="file" multiple />
```

Put this in your frontend JavaScript, loaded after the input exists. The package import works with a frontend bundler such as Vite:

```js
import { createHttpUploadClient } from "@itsgravix/parcelweave";

// Match the path in app.use() on your Express server.
const uploads = createHttpUploadClient({ endpoint: "/api/uploads" });

document.querySelector("#files").addEventListener("change", (event) => {
  for (const file of event.target.files) {
    uploads.upload(file, {
      onProgress({ file: sourceFile, percentage }) {
        // sourceFile is the same browser File or Blob passed to upload().
        console.log(`${sourceFile.name}: ${percentage}%`);
      },
    }).then((result) => {
      console.log("Upload complete:", result);
    }).catch((error) => {
      console.error(`Could not upload ${file.name}:`, error);
    });
  }
});
```

On the client, Parcelweave accepts the browser's native `File` or `Blob`. Your code keeps direct access to it, and `onProgress` receives it as `file`. You can read it with the browser's built-in `file.stream()` before or during the upload. Browser files are immutable; to change the uploaded bytes, create a new `File` or `Blob` and pass that value to `upload()`.

On the backend, the local-disk adapter calls `finalize()` only after every byte has been received and confirmed. Its `upload.createReadStream()` opens a fresh Node readable stream for the completed server-side file. The stream is created only when called, reads bounded chunks with backpressure, and does not load the entire file into memory.

`endpoint` tells the browser **where your server receives uploads**. It is the base URL for the routes you mounted above. If you change `app.use()` to `/files`, set `endpoint` to `/files` too. A relative URL uses the website's current origin; for a separate API server, use its full URL and configure CORS and authentication for that origin.

**IMPORTANT!** Use one upload client for all files. Parcelweave can only coordinate uploads that share a client. Separate clients still work, but their uploads compete for bandwidth and may fail on certain configurations.

See the [Express guide](docs/guides/express-local-disk.md) for storage limits, completion hooks, and setup troubleshooting.

## More control

### Choose how files are stored

Handle uploaded data directly with your own functions. `createUpload` can save any destination in your record, `writePart(context, upload, bytes, offset)` receives each accepted byte range, and `completeUpload(context, upload)` runs once the entire file has been received. You decide the directory, filename, stream, storage service, and finished-file behavior. No Parcelweave storage adapter is required.

Pass these functions directly to the Express router, Fetch handler, or standalone upload service. The browser code stays the same. See [custom byte and completion handlers](docs/guides/custom-storage.md) for the complete setup, including using your own streams.

### Customize how the browser sends files

Configure the HTTP layer separately when you need custom URLs, headers, authentication, or a partly customized transport:

```js
import { createHttpTransport, createUploadClient } from "@itsgravix/parcelweave";

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
- [Custom routes and servers](docs/guides/custom-router.md) — connect Parcelweave to an existing router or unusual URL layout.
- [Serverless and Fetch runtimes](docs/guides/serverless-fetch.md) — use standard `Request` and `Response` objects.
- [Custom transports](docs/guides/custom-transport.md) — use your own networking or endpoint-free integration.

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
| `createHttpUploadClient(options)` | You want the simplest browser-to-HTTP setup. Requires `endpoint`. |
| `createHttpTransport(options)` | You want to configure or extend the built-in HTTP behavior separately. |
| `createUploadClient({ transport, ...options })` | You want direct control over how operations are sent. It never assumes an endpoint. |
| `createExpressUploadRouter(options)` | You want ready-made routes inside an existing Express app. |
| `createFetchUploadHandler(options)` | Your runtime uses web-standard `Request` and `Response`. |
| `createUploadService(options)` | You want to connect the protocol engine to your own router. |

## Before production

- For public or multi-user servers, add authentication and ownership checks in your application callbacks.
- Limit file sizes, request rates, active sessions, and storage use.
- Generate storage paths on the server; never trust the original filename as a path.
- Persist offsets atomically when multiple processes can receive requests.
- Keep platform and proxy body limits above your configured maximum batch size.
- Inspect completed files before publishing or processing them.

Parcelweave is a focused upload tool, not a replacement for every upload system. Tus, object-storage multipart uploads, or a managed service may fit some applications better.

## License

MIT
