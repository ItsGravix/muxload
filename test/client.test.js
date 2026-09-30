import assert from "node:assert/strict";
import test from "node:test";
import { createUploadClient } from "../src/client.js";

test("the client requires an endpoint", () => {
  assert.throws(() => createUploadClient(), /non-empty endpoint/);
  assert.throws(() => createUploadClient({ endpoint: "" }), /non-empty endpoint/);
});

test("custom route functions work without changing the client", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    if (String(url).endsWith("/files/new")) {
      return new Response(JSON.stringify({ id: "custom-id", offset: 0 }), {
        status: 201, headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).endsWith("/files/custom-id/finish")) {
      return new Response(JSON.stringify({ id: "custom-id", complete: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "Unexpected route." }), { status: 404 });
  };

  try {
    const uploads = createUploadClient({
      endpoint: "https://uploads.example/v1",
      routes: {
        create: "files/new",
        complete: (id) => `files/${id}/finish`,
      },
    });
    const result = await uploads.upload(new Blob([]));
    assert.deepEqual(result, { id: "custom-id", complete: true });
    assert.deepEqual(requests, [
      { url: "https://uploads.example/v1/files/new", method: "POST" },
      { url: "https://uploads.example/v1/files/custom-id/finish", method: "POST" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
