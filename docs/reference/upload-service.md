# Connect a router directly

Use `createUploadService({ storage })` only when your framework cannot use the Express router or Fetch handler. Create one service when your server starts and reuse it across requests so its per-file locks are shared.

The service receives parsed values and returns results. Your router handles HTTP:

| Service call | Input from your router | Response |
| --- | --- | --- |
| `service.create(context, specification)` | JSON containing `name`, `size`, and `metadata` | 201 with `{ id, offset }` |
| `service.batch(context, bytes)` | Raw binary batch as `Uint8Array` | 200 with `{ offsets: { [id]: savedBytes } }` |
| `service.status(context, ids)` | Array of upload IDs | 200 with the same offsets shape |
| `service.complete(context, id)` | One upload ID | 200 with your completion result |
| `service.remove(context, id)` | One upload ID | 204 without a body |

`context` can be your request or application context. It is passed to your storage functions. Use either the optional storage container or your [own storage functions](../guides/custom-storage.md).

Your router must limit request bodies **before** buffering them: the built-in handlers allow 32 KiB for creation JSON and `maxBatchBytes + 64 KiB` for encoded batches. Binary batches use `application/vnd.parcelweave.batch`; JSON creation requests use `application/json`. Check the content type and do not parse batch bytes as text.

Return an `UploadHttpError`'s `status` and `{ ...error.details, error: error.message }` for errors in the 400–499 range. For other errors, send a generic 500 response and keep internal details in your server logs.

The browser's `routes` must match your URLs. For unusual external APIs, browser route values can also be functions: `complete: (id) => yourUrlFor(id)`. A `status` function receives the ID array and must build its query. The normal shared string configuration in the [route guide](../guides/custom-router.md) handles that automatically.

The service checks batches, handles duplicate pieces and coordinates writes inside one process. Your storage must safely record confirmed offsets, including when multiple processes receive requests. An existing API must implement these operations and response shapes; renaming routes alone does not make an arbitrary upload API compatible.
