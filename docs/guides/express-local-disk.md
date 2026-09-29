# Express and local disk

Start with the [Express quick start in the README](../../README.md#optional-quick-start-express), which connects a file picker to your existing Express server. This guide explains the settings and optional hooks.

## How the browser finds your server

Mount the router on your existing Express app:

```js
app.use("/api/parcelweave", createExpressUploadRouter({ express, storage }));
```

Then use the same path in your browser client. `endpoint` is the base URL of those server routes:

```js
import { createHttpUploadClient } from "@itsgravix/parcelweave";

const uploads = createHttpUploadClient({ endpoint: "/api/parcelweave" });

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
import { createExpressUploadRouter } from "@itsgravix/parcelweave/server";
import { createLocalStorage } from "@itsgravix/parcelweave/storage";

const storage = createLocalStorage({
  directory: "./uploads",
  maxFileBytes: 2 * 1024 ** 3,
  validate: async (request, file) => {
    // Optionally reject the file before accepting bytes.
  },
  finalize: async (request, upload) => {
    // upload.path is the completed temporary file.
    return { id: upload.id, complete: true };
  },
});

app.use("/api/parcelweave", createExpressUploadRouter({ express, storage }));
```

Files are saved as `uploads/<id>/data`; the original name stays in the upload record. Use one local-storage service instance per directory in a single Node.js process. For multiple server processes, use shared storage with atomic offset updates instead.

Make `finalize` safe to call again: if a process stops after your work finishes but before the result is recorded, the operation can be retried. Also schedule cleanup for abandoned uploads.

## If the first upload fails

- **404:** Check that the browser endpoint reaches the Express mount path, and that the router is mounted before catch-all routes.
- **CORS error:** If the browser and server have different origins, allow your frontend origin, the upload methods (`POST`, `GET`, `DELETE`), and required headers on the server. Cookie authentication across origins also needs the client's `credentials: "include"` setting and matching server CORS configuration.
- **415:** Let the Parcelweave router parse its binary request bodies. Avoid earlier middleware that consumes all request bodies as JSON, text, or raw data.
