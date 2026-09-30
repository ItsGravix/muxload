# Customize how uploads are sent

This guide covers the sending side of an upload. To change where received files are saved, use the [custom storage guide](custom-storage.md).

A **transport** is the code that talks to your upload server. Parcelweave includes one for HTTP. Start with it and change only what your app needs; scheduling, retries, and progress remain part of the upload client.

## Add authentication

You can use the normal browser client directly:

```js
import { createHttpUploadClient } from "@itsgravix/parcelweave";

const uploads = createHttpUploadClient({
  endpoint: "/api/uploads",
  headers: () => ({ Authorization: `Bearer ${getToken()}` }),
});
```

`getToken()` is your application's token function. Parcelweave calls the header function for each request. For cookie authentication on another origin, use `credentials: "include"` and configure CORS on that server.

## Use different route names

Keep the normal client and specify only the routes you changed on your server:

```js
const uploads = createHttpUploadClient({
  endpoint: "/api/uploads",
  routes: {
    create: "start",
    complete: (id) => `${encodeURIComponent(id)}/finish`,
  },
});
```

This sends start requests to `/api/uploads/start` and completion requests to `/api/uploads/<id>/finish`. It does not create these routes on your server. See the [custom router guide](custom-router.md).

## Change one operation

For example, add application behavior after the server confirms completion:

```js
import { createHttpTransport, createUploadClient } from "@itsgravix/parcelweave";

const http = createHttpTransport({ endpoint: "/api/uploads" });
const uploads = createUploadClient({
  transport: {
    ...http, // Keep the built-in sending, progress, and connection handling.
    async complete(id) {
      const result = await http.complete(id);
      console.log("Server finished this upload:", result);
      return result;
    },
  },
});
```

`complete()` is called after all file bytes have been confirmed. Returning its result delivers it to `await uploads.upload(file)`. If you add database writes or other side effects here, make them safe to repeat: completion can be retried.

## Connect directly to a service without HTTP

For tests or Node.js applications where the client and upload service run in the same process, use `createServiceTransport()`. It connects the operations for you:

```js
import { createUploadClient } from "@itsgravix/parcelweave";
import { createUploadService, createServiceTransport } from "@itsgravix/parcelweave/server";
import { createStorageContainer } from "@itsgravix/parcelweave/storage";

const service = createUploadService({
  storage: createStorageContainer({ directory: "./uploads" }),
});
const uploads = createUploadClient({ transport: createServiceTransport(service) });
await uploads.upload(new Blob(["Hello from Node.js"]));
```

The disk adapter is optional; the service also accepts your custom storage handlers. This helper reports progress after each batch is accepted and buffers only that batch. It does not connect a browser to a remote server. Use `{ context: () => yourContext }` as its second argument when your service handlers need application context.

## Implement a different connection

Only use this option if you need to send uploads through your own RPC client, native bridge, or another connection. You implement five operations:

| Operation | What your code does |
| --- | --- |
| `create` | Ask the receiver to start a file; return its ID and saved byte count (`offset`). |
| `batch` | Send the selected pieces of files; return how many bytes the receiver has saved for each file. |
| `status` | Ask how many bytes are saved, so a lost response does not force a restart. |
| `complete` | Ask the receiver to finish the upload; return the application's result. |
| `remove` | Ask the receiver to cancel and clean up the upload. |

The calls to `myApi` below are placeholders for your connection. Their inputs and return values must follow the contract below.

```js
import { createUploadClient } from "@itsgravix/parcelweave";

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

If your connection sends Parcelweave's binary format, use `encodeBatch(pieces)` from `@itsgravix/parcelweave/protocol`.

Your connection must preserve confirmed byte offsets and report failures accurately for retries and resume to work. The built-in HTTP transport already handles encoding, transmission progress, and stalled requests; reuse it when your server speaks Parcelweave's HTTP protocol.
