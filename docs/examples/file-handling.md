# File handling examples

Start with the [Express setup](../../README.md#optional-quick-start-express). These examples are optional additions.

## When the callbacks run

`validate(request, uploadInfo)` checks the declared name, size, and metadata before file bytes are accepted. A filename extension does not prove what the file contains.

`finalize(request, upload)` runs after the whole file has been saved. Parcelweave waits for it to finish, then returns its result to the browser's `uploads.upload()` call. With the storage container, `upload.path` is the saved file's path.

## Read a completed file

Use this callback in `createStorageContainer({ directory: "./uploads", finalize })`:

```js
import { createHash } from "node:crypto";

async function finalize(_request, upload) {
  const hash = createHash("sha256");

  // Each piece is a Buffer containing real bytes from the uploaded file.
  for await (const piece of upload.createReadStream()) {
    hash.update(piece);
  }

  return {
    id: upload.id,
    sha256: hash.digest("hex"),
  };
}
```

This reads the actual saved file and calculates its SHA-256 checksum. `piece` is a Node.js `Buffer`, so your code can inspect it, send it to a parser, update a hash, or pass it to another stream.

`createReadStream()` does not load the whole file into memory. It opens the file and supplies small pieces as the loop asks for them. Each call opens a fresh stream.

## Modify a text file

This example changes ASCII lowercase letters to uppercase. It is an illustration for text files, not a general image, audio, or Unicode conversion.

```js
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

async function* uppercaseAscii(pieces) {
  for await (const piece of pieces) {
    // ASCII lowercase letters have byte values 97 through 122.
    for (let i = 0; i < piece.length; i++) {
      if (piece[i] >= 97 && piece[i] <= 122) piece[i] -= 32;
    }
    yield piece;
  }
}

async function finalize(_request, upload) {
  const outputPath = upload.path + ".processed";
  try {
    await pipeline(
      upload.createReadStream(),       // Read the original.
      uppercaseAscii,                 // Modify each piece.
      createWriteStream(outputPath),   // Save the result.
    );
    await rename(outputPath, upload.path); // Replace after success.
  } finally {
    await rm(outputPath, { force: true });
  }
  return { id: upload.id, processed: true };
}
```

`pipeline()` connects reading, processing, and writing. It waits for completion, handles stream errors, and slows reading when writing cannot keep up. Memory stays bounded, but this example needs temporary disk space for a second file. Never write to the same file you are still reading.

Completion can be retried after a failure or restart. Make processing safe to repeat; uppercasing already-uppercase ASCII leaves it unchanged. External actions such as sending email or billing need their own duplicate protection.

## Read or change a file in the browser

The browser already gives you a `File`. Its native `stream()` method reads it in pieces:

```js
const file = document.querySelector("#files").files[0];
const reader = file.stream().getReader();
let bytesRead = 0;
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
  }
} finally {
  reader.releaseLock();
}
console.log("Bytes read:", bytesRead);
```

For a small text file, you can create an edited file before uploading:

```js
if (file.size > 1024 * 1024) throw new Error("This example is limited to 1 MiB.");
const text = await file.text();
const edited = new File([text.toUpperCase()], file.name, { type: "text/plain" });
await uploads.upload(edited); // Reuse the client from your app.
```

This small-file example holds the text and edited content in memory. For large-file transformations, use a streaming server process like the example above. Parcelweave's browser client requires a replayable `File` or `Blob` so it can retry byte ranges; it does not accept a one-use readable stream as an upload source.

## Use your own storage

`upload.createReadStream()` is a convenience of the storage container. With custom storage, your `completeUpload()` callback can open a stream using your filesystem or storage service. See the [custom byte handler guide](../guides/custom-storage.md).
