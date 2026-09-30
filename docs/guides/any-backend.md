# Use Parcelweave with your backend

You do not need Express. Create an upload handler once, then pass requests to it from your existing server.

## Frameworks with Request and Response

```js
import { createUploadHandler } from "@itsgravix/parcelweave/server";
import { storage } from "./upload-storage.js";

const handleUpload = createUploadHandler({
  basePath: "/api/uploads",
  storage,
});

// Call this from your framework's request handler.
export function handleRequest(request) {
  return handleUpload(request);
}
```

`request` is a standard Web `Request`. The returned promise resolves to a standard `Response`, ready for your framework to send. Your app forwards requests under `/api/uploads` to this handler; it keeps handling its other URLs normally. Parcelweave does not start a server.

`upload-storage.js` is your application's storage setup. It can export the optional `createStorageContainer({ directory: "./uploads" })` on Node, or your [custom storage functions](custom-storage.md). A local directory is not required.

## Frameworks with their own request objects

Pass the method, URL, headers and raw body:

```js
const response = await handleUpload({
  method: request.method,
  url: request.url,
  headers: request.headers,
  body: rawBody,
}, request);
```

Map those fields from your framework. `headers` accepts a standard `Headers`, a string-valued object, or header pairs. `rawBody` can be a `Uint8Array` or a Web `ReadableStream`; omit it for GET/HEAD requests. Use the raw bytes, not a JSON-parsed object. Prefer a stream so Parcelweave can enforce body limits as bytes arrive. If your framework has already buffered the body, configure its size limit too.

Send the returned response's status, headers and body using your framework's response API. The optional second argument is passed to your storage functions, so they can access your original request or application context.

Parcelweave handles route matching, body parsing, upload validation, confirmed offsets and error responses. You do not need to implement five HTTP handlers.

## Plain Node.js

For Node's built-in HTTP server, use the ready-made adapter:

```js
import { createServer } from "node:http";
import { createNodeUploadHandler } from "@itsgravix/parcelweave/node";
import { createStorageContainer } from "@itsgravix/parcelweave/storage";

const handleUpload = createNodeUploadHandler({
  basePath: "/api/uploads",
  storage: createStorageContainer({ directory: "./uploads" }),
});

createServer(async (request, response) => {
  if (await handleUpload(request, response)) return;

  // Your other application routes go here.
  response.end("Server is running");
}).listen(3000);
```

The Node adapter sends the response for you. It returns `false` for URLs outside `basePath`, leaving those requests untouched. URLs inside that path belong to Parcelweave. Create the handler once, not once per request. You can also pass your own storage functions here.

## Browser

The browser setup is the same with every backend:

```js
const uploads = createUploadClient({ endpoint: "/api/uploads" });
```

For a different domain, use its full URL and configure CORS on that server. The same [custom route settings](custom-router.md) work with these handlers.

## Other backend languages

This package runs in JavaScript runtimes. A Python, Go or PHP application can use a separate JavaScript upload service and connect it to its own storage/backend, or implement the Parcelweave protocol in that language. It cannot import this package directly.
