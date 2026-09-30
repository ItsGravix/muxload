# Express and local disk

Start with the [Express quick start in the README](../../README.md#optional-quick-start-express), which connects a file picker to your existing Express server. This guide explains the settings and optional hooks.

## How the browser finds your server

Mount the router on your existing Express app:

```js
app.use("/api/uploads", createExpressUploadRouter({ express, storage }));
```

Then use the same path in your browser client. `endpoint` is the base URL of those server routes:

```js
import { createHttpUploadClient } from "@itsgravix/parcelweave";

const uploads = createHttpUploadClient({ endpoint: "/api/uploads" });

// file is a File from your page's file input.
const result = await uploads.upload(file, {
  metadata: { kind: "audio" },
  onProgress({ percentage }) {
    console.log(`${percentage}%`);
  },
});
```

Keep one client for the page. Calling `upload()` again adds the new file to the same scheduler, even while other files are moving.

If you choose `/files` instead, change both paths to `/files`. A relative endpoint uses the browser page's origin. During local development, if your frontend and Express app run on different ports, either proxy this path to Express through your frontend development server or use the Express server's full URL and configure CORS and authentication accordingly.

## Configure storage on your server

Use your existing `app`. No login, user, or session is required for this local setup.

```js
import express from "express";
import { createExpressUploadRouter, UploadHttpError } from "@itsgravix/parcelweave/server";
import { createLocalStorage } from "@itsgravix/parcelweave/storage";

const storage = createLocalStorage({
  directory: "./uploads",
  maxFileBytes: 2 * 1024 ** 3,
  // Runs once before any file bytes are accepted.
  validate: async (_request, uploadInfo) => {
    if (!uploadInfo.name.toLowerCase().endsWith(".txt")) {
      throw new UploadHttpError(415, "Only text files are allowed.");
    }
  },
  finalize: async (_request, upload) => {
    // The full file is now saved at upload.path.
    console.log("Upload received:", upload.name);
    // Return the information your browser needs.
    return { id: upload.id, name: upload.name };
  },
});

app.use("/api/uploads", createExpressUploadRouter({ express, storage }));
```

Incoming files are saved as `uploads/<id>/data`. `finalize` runs only after the full file has arrived; `upload.createReadStream()` reads it with Node stream backpressure instead of buffering the full file. The original name stays in the upload record. Use one local-storage service instance per directory in a single Node.js process. For multiple server processes, use shared storage with atomic offset updates instead.

`validate(request, uploadInfo)` runs once before the adapter creates the upload directory or accepts file bytes. It can check the declared `name`, `size`, and `metadata`, but it cannot inspect content. Use `finalize()` to inspect the fully received file, or custom `writePart()` callbacks for incremental byte inspection.

The browser side still owns its original `File` or `Blob`; call its native `stream()` method when client code needs to inspect it. The backend stream is separate and reads the fully received server-side copy. Neither Parcelweave API eagerly duplicates the whole file in memory.

Make `finalize` safe to call again: if a process stops after your work finishes but before the result is recorded, the operation can be retried. Also schedule cleanup for abandoned uploads.

See the [file handling examples](../examples/file-handling.md) for reading and modifying completed files.

## If the first upload fails

- **404:** Check that the browser endpoint matches the path used in `app.use()`.
- **CORS error:** If the browser and server have different origins, allow your frontend origin, the upload methods (`POST`, `GET`, `DELETE`), and required headers on the server. Cookie authentication across origins also needs the client's `credentials: "include"` setting and matching server CORS configuration.
- **415:** Let the Parcelweave router parse its binary request bodies. Avoid earlier middleware that consumes all request bodies as JSON, text, or raw data.
