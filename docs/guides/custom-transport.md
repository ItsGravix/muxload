# Custom transports

The upload scheduler does not require HTTP or an endpoint. A transport is the small adapter that connects its five operations to your infrastructure.

```js
import { createUploadClient } from "@itsgravix/muxload";

const uploads = createUploadClient({
  transport: {
    create: (specification, { signal }) => myApi.create(specification, signal),
    batch: (pieces, { onProgress }) => myApi.sendPieces(pieces, onProgress),
    status: (ids) => myApi.status(ids),
    complete: (id) => myApi.complete(id),
    remove: (id) => myApi.remove(id),
  },
});
```

The methods return promises:

- `create` returns `{ id, offset }`.
- `batch` receives `{ id, offset, length, blob }` pieces and returns `{ offsets: { [id]: savedBytes } }`.
- `status` returns the same offsets shape.
- `complete` returns your application's result.
- `remove` does not need a result.

`batch` should call `onProgress(bytesSent)` with cumulative payload bytes for that batch, in piece order. It must settle its promise on success, failure, and stalled operations. Throw `new UploadError(message, { retryable: true })` for temporary failures; other errors stop the affected uploads.

If your connection sends Muxload's binary format, use `encodeBatch(pieces)` from `@itsgravix/muxload/protocol`.

You can also replace only one part of the built-in HTTP behavior:

```js
import { createHttpTransport, createUploadClient } from "@itsgravix/muxload";

const http = createHttpTransport({ endpoint: "/api/muxload" });
const uploads = createUploadClient({
  transport: { ...http, complete: (id) => myApi.publish(id) },
});
```

The scheduler remains unchanged whether data travels through Muxload HTTP routes, your own client library, RPC, a native bridge, or an in-process service.
