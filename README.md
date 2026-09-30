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
npm install github:ItsGravix/parcelweave#v0.13.1
```

## Optional quick start: Express

This section shows one ready-made setup if you use Express. It is not required to use Parcelweave. For another server or infrastructure, go to the [custom server guide](docs/guides/custom-router.md), [Fetch and serverless guide](docs/guides/serverless-fetch.md), or [custom transport guide](docs/guides/custom-transport.md).


### 1. Add uploads to your Express server

If you already have an Express app, add the imports near the top of your server file and mount the router. This quick start uses Parcelweave's optional storage container; you can replace it with your own storage functions.

```js
import express from "express";

// Parcelweave imports.
import { createExpressUploadRouter } from "@itsgravix/parcelweave/server";
import { createStorageContainer } from "@itsgravix/parcelweave/storage";

// Parcelweave setup starts here. This storage container is optional.
const storage = createStorageContainer({
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
import { createStorageContainer } from "@itsgravix/parcelweave/storage";

// Your normal Express setup.
const app = express();
app.use(express.json());

// Your normal application routes can come before or after Parcelweave.
app.get("/", (request, response) => response.send("Server is running"));

// Parcelweave setup starts here. This storage container is optional.
const storage = createStorageContainer({
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

#### Choose how uploads are stored

`createStorageContainer()` is optional. It is a ready-made local-disk adapter for the shortest setup.

You can instead connect Parcelweave directly to your own filesystem, object storage, database, stream, or service by providing `createUpload`, `resolveUpload`, `writePart`, `completeUpload`, and `removeUpload`. Parcelweave's upload protocol and browser client work with either approach.

#### If you use the local-disk adapter

`createStorageContainer()` creates the chosen directory when the first upload starts. Each upload is one file named with a random upload ID. It does not add metadata or JSON sidecar files to the folder.

##### Resume state

The simple adapter keeps offsets and metadata in memory. Interrupted uploads can resume while the server is running. To resume after a server restart, provide a `state` adapter backed by your database or cache.

##### Validation and completed files

`validate(request, uploadInfo)` runs before the file is created or any bytes are accepted. It receives the client-declared `name`, `size`, and `metadata`, but not the file contents.

Use `finalize()` to inspect the completed file, or a custom `writePart()` to inspect pieces as they arrive. See the [file handling examples](docs/examples/file-handling.md).

#### Connect your own storage

Pass your storage functions directly to the router instead of passing `storage`. Your code controls where bytes go, how offsets are saved, and what happens when an upload completes. See the [custom byte handler guide](docs/guides/custom-storage.md).

#### Protect public uploads

Upload IDs identify uploads; they are not authentication. Public or multi-user applications should check authorization in their custom callbacks.

#### Match the browser endpoint

`app.use("/api/uploads", ...)` mounts the server routes at `/api/uploads`. Use that same path for the browser client's `endpoint`. You may replace it with any URL you choose.

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

### Browser setup details

#### Reuse one browser client

This means the `uploads` object created by `createHttpUploadClient()` in your frontend—not the Express router on your backend.

Create it once and use it for every file on the page. Files using the same browser client can share the connection and be coordinated together. Separate clients upload independently.

#### Connect the browser to the server route

The browser's `endpoint` should match the path where the backend mounted its upload router:

```js
// Backend (Express)
app.use("/api/uploads", router);

// Frontend (browser)
const uploads = createHttpUploadClient({ endpoint: "/api/uploads" });
```

For an upload server on another origin, use its full URL and configure CORS and authentication there.

#### Access the original browser file

The browser gives you a normal `File` or `Blob`, and `onProgress` returns the same value as `file`.

### Server-side file access

This is separate from the browser client. Your backend normally creates and mounts its Parcelweave router once when the server starts; it does not create a router for each file.

If your backend uses the optional local-disk adapter, `finalize()` runs after the complete file arrives. `upload.createReadStream()` then lets the server read it in small pieces without loading the whole file into memory. Custom storage handlers can provide their own way to access completed files.

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
