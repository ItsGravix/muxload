# Change the upload URL

Usually, you only need to choose where uploads live in your app.

```js
// Server: use your existing Express app and storage setup.
app.use("/files", createExpressUploadRouter({ express, storage }));

// Browser: point to the same URL.
const uploads = createUploadClient({ endpoint: "/files" });
```

Parcelweave creates the upload routes under `/files` and handles the requests for you. See the [complete Express setup](../../README.md#optional-quick-start-express) for imports and storage setup.

## Upload to another server

Use its full URL in the browser:

```js
const uploads = createUploadClient({
  endpoint: "https://uploads.example.com/files",
});
```

That server must run Parcelweave's upload handler and allow your website through CORS. An ordinary file upload endpoint will not understand Parcelweave's requests. If your server requires authentication, supply `headers` or `credentials: "include"` as appropriate.

## Change individual route names

Only use `routes` if changing the base URL is not enough. Put the paths you want to change in a shared file:

```js
// upload-routes.js — imported by your browser and server code.
export const routes = {
  create: "start",              // Start a file upload.
  batch: "pieces",              // Receive pieces of files.
  status: "progress",           // Check how many bytes are saved.
  complete: ":id/finish",       // Finish a file upload.
  remove: ":id",               // Cancel a file upload.
};
```

Pass that same object to both sides:

```js
// Server
app.use("/files", createExpressUploadRouter({ express, storage, routes }));

// Browser
const uploads = createUploadClient({ endpoint: "/files", routes });
```

Both snippets import `routes` from your shared file. `:id` is replaced with the upload ID automatically. Parcelweave also builds the progress query and handles request parsing and error responses. You do not need to write the five request handlers.

You can change just one path, such as `{ batch: "pieces" }`; the rest keep their defaults. Paths are relative to the base URL. The defaults are `uploads`, `batches`, `status`, `uploads/:id/complete`, and `uploads/:id`.

## Using another framework

Use `createUploadHandler({ basePath: "/files", storage, routes })` with your framework. It accepts the same route settings and handles requests without Express. See [other backend setups](any-backend.md), including plain Node.js and frameworks with their own request objects.

For a router that cannot use either handler, `createUploadService()` exposes the underlying operations. That is an advanced integration: your router must parse bounded request bodies and send HTTP responses. See the [service reference](../reference/upload-service.md).

Choosing custom storage is independent of changing URLs. See [custom storage](custom-storage.md) if you want to decide how bytes are saved.
