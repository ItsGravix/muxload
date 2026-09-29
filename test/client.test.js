import assert from "node:assert/strict";
import test from "node:test";
import { createUploadClient } from "../src/client.js";

test("cancelling one file preserves the other file in a shared batch", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let sequence = 0;
  const ids = [];
  const removed = [];
  const client = createUploadClient({
    prepare: () => Promise.resolve(),
    onEvent(event) { if (event.type === "created") ids.push(event.id); },
    transport: {
      async create() { return { id: String(++sequence), offset: 0 }; },
      async batch(entries) {
        started(); await gate;
        return { offsets: Object.fromEntries(entries.map((entry) => [entry.id, entry.offset + entry.length])) };
      },
      async status() { return { offsets: {} }; },
      async complete(id) { return { id }; },
      async remove(id) { removed.push(id); },
    },
  });
  const first = client.upload(new Blob(["one"]));
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = client.upload(new Blob(["two"]));
  await entered;
  client.cancel(ids[0]);
  release();
  await rejected;
  assert.deepEqual(await second, { id: ids[1] });
  assert.deepEqual(removed, [ids[0]]);
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
