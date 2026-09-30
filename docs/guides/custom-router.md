# Custom routes and servers

Use this setup when you already have a router, cannot mount an Express router, or need your own URL layout.

## Browser routes

Give the upload client your endpoint and any route names that differ from Parcelweave's defaults:

```js
import { createUploadClient } from "@itsgravix/parcelweave";

const uploads = createUploadClient({
  endpoint: "/api",
  routes: {
    create: "files/new",
    batch: "files/data",
    status: (ids) => `files/status?ids=${ids.map(encodeURIComponent).join(",")}`,
    complete: (id) => `files/${encodeURIComponent(id)}/complete`,
    remove: (id) => `files/${encodeURIComponent(id)}`,
  },
});
```

Route values may be full URLs, so individual operations can live on different services.

## Connect your router

```js
import { createUploadService } from "@itsgravix/parcelweave/server";

const mux = createUploadService({
  createUpload,
  resolveUpload,
  writePart,
  completeUpload,
  removeUpload,
});

router.post("/files/new", async (req, res) => res.status(201).json(await mux.create(req, req.body)));
router.post("/files/data", async (req, res) => res.json(await mux.batch(req, req.rawBody)));
router.get("/files/status", async (req, res) => res.json(await mux.status(req, req.query.ids.split(","))));
router.post("/files/:id/complete", async (req, res) => res.json(await mux.complete(req, req.params.id)));
router.delete("/files/:id", async (req, res) => {
  await mux.remove(req, req.params.id);
  res.status(204).end();
});
```

The batch route must give `mux.batch()` the raw binary request body. Do not parse it as JSON or text. Catch `UploadHttpError` in your normal error middleware and return its `status`, `message`, and optional `details`.

## Storage contract

| Callback | Responsibility |
| --- | --- |
| `createUpload(context, specification)` | Create a record and return `{ id, size, offset }`. Add application checks here if needed. |
| `resolveUpload(context, id)` | Return the current record. Add authorization here if needed. |
| `writePart(context, upload, bytes, offset)` | Store unchanged bytes at the exact offset. |
| `completeUpload(context, upload)` | Validate or publish the finished file and return a result. |
| `removeUpload(context, upload)` | Remove temporary bytes and the record. |

Parcelweave handles decoding, bounds checks, duplicate pieces, offset reconciliation, and locking inside one service instance. Shared or multi-process storage must update offsets atomically.
