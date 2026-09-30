# Serverless and Fetch runtimes

Use the shared upload handler in Workers, serverless functions, or frameworks built around standard `Request` and `Response` objects. For other request formats or plain Node.js, see [backend integration](any-backend.md).

```js
import { createUploadHandler } from "@itsgravix/parcelweave/server";
import { storage } from "./upload-storage.js";

const handleUpload = createUploadHandler({
  basePath: "/api/uploads",
  storage,
});

export default {
  fetch(request) {
    return handleUpload(request);
  },
};
```

Your platform invokes the handler. Parcelweave does not listen on a port or host a web server.

`upload-storage.js` is your application's [storage implementation](custom-storage.md). It exports the functions that save bytes and upload records in your chosen destination. The handler also accepts the shared `routes` option for [custom URLs](custom-router.md).

The browser can use the easy HTTP client:

```js
import { createUploadClient } from "@itsgravix/parcelweave";

const uploads = createUploadClient({ endpoint: "/api/uploads" });
```

Do not keep upload records or offsets only in an in-memory `Map`. Separate requests may run on different machines. Store bytes and records in durable storage, and protect offset updates with a transaction, conditional write, or another atomic mechanism.

For another domain, pass the full endpoint plus any credentials or headers. Configure CORS to allow your website origin, Parcelweave's HTTP methods, `Content-Type`, and authentication headers.
