# Handle bytes and completed uploads yourself

Supply functions directly to Parcelweave. You control what happens to each byte range and to the completed file; no folder, memory adapter, or Parcelweave storage implementation is required.

## What these functions change

Think of these functions as a storage extension. They connect your own filesystem, object storage, database, or service to Parcelweave. They do **not** replace Parcelweave's multiplexing, fair scheduling, concurrency, retries, resume logic, progress reporting, pause controls, or protocol validation.

They are active storage operations, not notification events. The most important rule is that `writePart()` should finish only after your destination has accepted the bytes, and `resolveUpload()` should return the latest confirmed offset. Parcelweave uses that offset to resume safely without restarting the file.

## Express example

```js
import { createExpressUploadRouter } from '@itsgravix/parcelweave/server';

app.use('/api/uploads', createExpressUploadRouter({
  express,
  async createUpload(request, specification) {
    return yourUploads.start(specification);
  },
  async resolveUpload(request, id) {
    return yourUploads.find(id);
  },
  async writePart(request, upload, bytes, offset) {
    // The actual bytes, as a Uint8Array, and their position in the file.
    await yourUploads.acceptBytes(upload.id, bytes, offset);
  },
  async completeUpload(request, upload) {
    // Return your application's result to the browser.
    return yourUploads.finish(upload.id);
  },
  async removeUpload(request, upload) {
    await yourUploads.cancel(upload.id);
  },
}));
```

`yourUploads` stands for your own functions or service. Replace those calls with your implementation. The same five functions work with `createFetchUploadHandler` and `createUploadService`; you can also group them into a `storage` object for reuse. Parcelweave has no user or authentication concept. If your application needs access control, use the supplied `context` inside these functions and implement your own checks.

## What each function receives and returns

| Function | Your responsibility |
| --- | --- |
| `createUpload(context, specification)` | Enforce your limits and create a record. Return `{ id, size, offset: 0, ...yourFields }`. The specification contains `name`, `size`, and `metadata`. |
| `resolveUpload(context, id)` | Return the latest record, including its confirmed `offset`. Throw if it is unavailable. Apply application authorization here if needed. |
| `writePart(context, upload, bytes, offset)` | Accept the byte range and record the new confirmed offset. Resolve only after your destination has accepted the data to the durability level your application promises. |
| `completeUpload(context, upload)` | Finish your processing and return a JSON-compatible result, such as `{ assetId }`. Preserve the result so retries do not repeat side effects. |
| `removeUpload(context, upload)` | Release your resources and remove the upload record. |

The context is the Express request, the Fetch handler's supplied context (the Request by default), or whatever you pass to the standalone service. Records can include your own fields, such as a destination key or processing job ID. Parcelweave does not assemble a complete file object for a custom handler: your completion function retrieves bytes or a stream from the destination you chose.

Choose any directory, object key, stream, or filename inside `createUpload`, save that value in your own record, and return it again from `resolveUpload`. Parcelweave passes the record to `writePart`, so the handler can write each byte range to that destination. Parcelweave does not interpret the destination or impose a directory layout.

## Send pieces to your own stream

For a Node.js Writable, you can await its write callback inside `writePart`:

```js
async function writePart(context, upload, bytes, offset) {
  // Your code selects a destination positioned at this confirmed offset.
  const destination = await yourUploads.writableAt(upload.id, offset);
  await new Promise((resolve, reject) => {
    destination.write(bytes, (error) => error ? reject(error) : resolve());
  });
  // Perform any flush/commit your destination needs before acknowledging.
  await yourUploads.confirm(upload.id, offset + bytes.byteLength);
}
```

The destination's owner must handle its stream errors and lifecycle. A write callback means the stream handled the piece; it does not necessarily mean the bytes are durable. Your completion handler can close the stream and finish processing. For a Web WritableStream, use your own writer and await `writer.write(bytes)` before confirming the offset.

These are piece callbacks, not a live stream of the incoming HTTP body. The built-in HTTP handlers currently read and decode a bounded batch before calling `writePart`. They do not buffer the entire file. You can feed those pieces into your own stream without concatenating the full file.

## Keep retries correct

Parcelweave skips already-confirmed pieces and serializes writes to each file within one service instance. Your `resolveUpload` must return the offset saved by `writePart`. If data was written but recording the offset failed, the same range can arrive again: make replay safe. An append-only stream without recovery or offset tracking is insufficient for resumable uploads.

Keep confirmed state across requests, and across restarts if you promise persistent resume. Multiple processes need shared locking or transactional offset checks. Parcelweave's locks apply only inside one service instance.

Do not retain the incoming `bytes` view unnecessarily: it shares the batch's buffer. If you need a long-lived copy, `bytes.slice()` copies just that piece. Await processing before returning so failed writes are not acknowledged as successful.

You may override any one callback alongside an existing `storage` adapter. For example, override `completeUpload` to notify another backend. Make that notification safe to repeat using the upload ID as an idempotency key.
