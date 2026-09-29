# Serverless and Fetch runtimes

Use the Fetch handler in Workers, serverless functions, or frameworks built around standard `Request` and `Response` objects.

```js
import { createFetchUploadHandler } from "@itsgravix/muxload/server";

const handleUpload = createFetchUploadHandler({
  basePath: "/api/muxload",
  createUpload,
  resolveUpload,
  writePart,
  completeUpload,
  removeUpload,
});

export default {
  fetch(request) {
    return handleUpload(request);
  },
};
```

Your platform invokes the handler. Muxload does not listen on a port or host a web server.

The browser can use the easy HTTP client:

```js
import { createHttpUploadClient } from "@itsgravix/muxload";

const uploads = createHttpUploadClient({ endpoint: "/api/muxload" });
```

Do not keep upload records or offsets only in an in-memory `Map`. Separate requests may run on different machines. Store bytes and records in durable storage, and protect offset updates with a transaction, conditional write, or another atomic mechanism.

For another domain, pass the full endpoint plus any credentials or headers. Configure CORS to allow your website origin, Muxload's HTTP methods, `Content-Type`, and authentication headers.
