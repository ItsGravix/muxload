# Express and local disk

This is the shortest complete Muxload setup. Your application owns the Express server; Muxload only supplies an upload router and storage adapter.

## Browser

```js
import { createHttpUploadClient } from "@itsgravix/muxload";

const uploads = createHttpUploadClient({ endpoint: "/api/muxload" });

const result = await uploads.upload(file, {
  metadata: { kind: "audio" },
  onProgress({ percentage }) {
    console.log(`${percentage}%`);
  },
});
```

Keep one client for the page. Calling `upload()` again adds the new file to the same scheduler, even while other files are moving.

## Server

```js
import express from "express";
import { createExpressUploadRouter } from "@itsgravix/muxload/server";
import { createLocalStorage } from "@itsgravix/muxload/storage";

const app = express();
const storage = createLocalStorage({
  directory: "./uploads",
  owner: (request) => request.user?.id,
  maxFileBytes: 2 * 1024 ** 3,
  validate: async (request, file) => {
    // Optionally reject the file before accepting bytes.
  },
  finalize: async (request, upload) => {
    // upload.path is the completed temporary file.
    return { id: upload.id, path: upload.path };
  },
});

app.use("/api/muxload", createExpressUploadRouter({ express, storage }));
app.listen(3000);
```

Files are saved as `uploads/<id>/data`; the original name stays in the upload record. Use one local-storage service instance per directory in a single Node.js process. For multiple server processes, use shared storage with atomic offset updates instead.

Make `finalize` safe to call again: if a process stops after your work finishes but before the result is recorded, the operation can be retried. Also schedule cleanup for abandoned uploads.
