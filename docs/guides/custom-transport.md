# Customize how uploads are sent

This guide covers the sending side of an upload. To change where received files are saved, use the [custom storage guide](custom-storage.md).

A **transport** is the code that talks to your upload server. Parcelweave includes one for HTTP. Start with it and change only what your app needs; scheduling, retries, and progress remain part of the upload client.

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

## Available operations

You can replace any of these methods. For a completely custom connection, supply all five to `createUploadClient({ transport })`:

| Operation | What your code does |
| --- | --- |
| `create` | Ask the receiver to start a file; return its ID and saved byte count (`offset`). |
| `batch` | Send the selected pieces of files; return how many bytes the receiver has saved for each file. |
| `status` | Ask how many bytes are saved, so a lost response does not force a restart. |
| `complete` | Ask the receiver to finish the upload; return the application's result. |
| `remove` | Ask the receiver to cancel and clean up the upload. |

<details>
<summary>Return values and retry requirements for custom connections</summary>

The methods return promises:

- `create` returns `{ id, offset }`.
- `batch` receives `{ id, offset, length, blob }` pieces and returns `{ offsets: { [id]: savedBytes } }`.
- `status` returns the same offsets shape.
- `complete` returns your application's result.
- `remove` does not need a result.

`batch` should call `onProgress(bytesSent)` with cumulative payload bytes for that batch, in piece order. It must settle its promise on success, failure, and stalled operations. Throw `new UploadError(message, { retryable: true })` for temporary failures; other errors stop the affected uploads.

If your connection sends Parcelweave's binary format, use `encodeBatch(pieces)` from `@itsgravix/parcelweave/protocol`.

Your connection must preserve confirmed byte offsets and report failures accurately for retries and resume to work. The built-in HTTP transport already handles encoding, transmission progress, and stalled requests; reuse it when your server speaks Parcelweave's HTTP protocol.

</details>

## Useful shortcuts

- **Authentication or custom URLs:** the standard HTTP client accepts `headers`, `credentials`, and `routes`. See the [custom router guide](custom-router.md).
- **No HTTP, same Node.js process:** `createServiceTransport(service, { context })` from `@itsgravix/parcelweave/server` connects an existing upload service to the client. `context` is optional and can be a value or a function. Progress is reported after each batch is accepted.
