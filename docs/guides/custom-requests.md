# Use your own request functions

Give `createUploadClient()` five callbacks when you want to use Socket.IO, a native bridge, or your own API instead of Parcelweave's HTTP requests.

Parcelweave still splits and coordinates files, reports progress, retries failures, and resumes uploads. Your callbacks only send requests and return the receiver's answers.

```js
import { createUploadClient } from "@itsgravix/parcelweave";

const uploads = createUploadClient({
  createUpload: (details) => socket.emitWithAck("upload:create", details),
  async sendParts(parts, { onProgress }) {
    const result = await socket.emitWithAck("upload:parts", parts);
    onProgress(parts.reduce((total, part) => total + part.length, 0));
    return result;
  },
  getUploadStatus: (ids) => socket.emitWithAck("upload:status", ids),
  completeUpload: (id) => socket.emitWithAck("upload:complete", id),
  cancelUpload: (id) => socket.emitWithAck("upload:cancel", id),
});

await uploads.upload(file);
```

The callbacks mean:

| Callback | What it asks your receiver to do |
| --- | --- |
| `createUpload` | Start a file and return `{ id, offset }`. |
| `sendParts` | Save the supplied file pieces and return the confirmed offset for each file. |
| `getUploadStatus` | Return the confirmed offsets after a lost request or response. |
| `completeUpload` | Finish the file and return your application's result. |
| `cancelUpload` | Cancel the file and clean up its temporary data. |

Each callback returns a promise. The receiver must confirm saved offsets; emitting a message without waiting for its answer cannot provide reliable retry and resume.

`sendParts(parts, { onProgress })` may call `onProgress(bytesSent)` while sending. Temporary failures can throw `new UploadError(message, { retryable: true })`; other errors stop the affected upload.

For HTTP, simply use `createUploadClient({ endpoint: "/api/uploads" })`. It handles these requests, transmission progress, and stalled connections for you.

You can also provide an `endpoint` and replace only the callback you need. Parcelweave uses its built-in HTTP requests for the others.
