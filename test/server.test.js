import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { once } from "node:events";
import { createExpressUploadRouter, createFetchUploadHandler, createUploadService, UploadHttpError } from "../src/server.js";
import { encodeBatch } from "../src/protocol.js";

async function fixture() {
  const sessions = new Map();
  let sequence = 0;
  const app = express();
  app.use("/uploads", createExpressUploadRouter({
    express,
    maxBatchBytes: 1024,
    async createUpload(_request, spec) {
      const upload = { id: `u${sequence += 1}`, size: spec.size, offset: 0, bytes: Buffer.alloc(spec.size) };
      sessions.set(upload.id, upload);
      return upload;
    },
    async resolveUpload(_request, id) {
      const upload = sessions.get(id);
      if (!upload) throw new UploadHttpError(404, "Missing.");
      return upload;
    },
    async writePart(_request, upload, bytes, offset) {
      Buffer.from(bytes).copy(upload.bytes, offset);
    },
    async completeUpload(_request, upload) {
      return { id: upload.id, text: upload.bytes.toString() };
    },
    async removeUpload(_request, upload) {
      sessions.delete(upload.id);
    },
  }));
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/uploads`;
  return { sessions, server, base };
}

async function create(base, name, size) {
  const response = await fetch(`${base}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, size, metadata: {} }),
  });
  return response.json();
}

async function send(base, entries) {
  const encoded = encodeBatch(entries);
  return fetch(`${base}/batches`, { method: "POST", body: encoded.body });
}

test("commits multiple files and makes a repeated batch idempotent", async (context) => {
  const { sessions, server, base } = await fixture();
  context.after(() => server.close());
  const a = await create(base, "a", 3);
  const b = await create(base, "b", 4);
  const entries = [
    { id: a.id, offset: 0, length: 3, blob: new Blob(["abc"]) },
    { id: b.id, offset: 0, length: 4, blob: new Blob(["wxyz"]) },
  ];
  assert.equal((await send(base, entries)).status, 200);
  assert.equal((await send(base, entries)).status, 200);
  assert.equal(sessions.get(a.id).bytes.toString(), "abc");
  assert.equal(sessions.get(b.id).bytes.toString(), "wxyz");
});

test("returns confirmed offsets when a client sends an invalid future offset", async (context) => {
  const { server, base } = await fixture();
  context.after(() => server.close());
  const upload = await create(base, "a", 5);
  const response = await send(base, [
    { id: upload.id, offset: 2, length: 1, blob: new Blob(["c"]) },
  ]);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Upload offsets no longer match.", offsets: { [upload.id]: 0 },
  });
});

test("portable Fetch handler owns routing, decoding, offsets and responses", async () => {
  const sessions = new Map();
  let sequence = 0;
  const handle = createFetchUploadHandler({
    basePath: "/v1",
    maxBatchBytes: 1024,
    async createUpload(_request, spec) {
      const upload = { id: `f${sequence += 1}`, size: spec.size, offset: 0, bytes: Buffer.alloc(spec.size) };
      sessions.set(upload.id, upload);
      return upload;
    },
    async resolveUpload(_request, id) {
      const upload = sessions.get(id);
      if (!upload) throw new UploadHttpError(404, "Missing.");
      return upload;
    },
    async writePart(_request, upload, bytes, offset) { Buffer.from(bytes).copy(upload.bytes, offset); },
    async completeUpload(_request, upload) { return { id: upload.id, text: upload.bytes.toString() }; },
    async removeUpload(_request, upload) { sessions.delete(upload.id); },
  });

  const createdResponse = await handle(new Request("https://uploads.example/v1/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "portable.bin", size: 5, metadata: {} }),
  }));
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  const encoded = encodeBatch([{ id: created.id, offset: 0, length: 5, blob: new Blob(["hello"]) }]);
  const batchResponse = await handle(new Request("https://uploads.example/v1/batches", {
    method: "POST", body: encoded.body,
  }));
  assert.equal(batchResponse.status, 200);
  assert.deepEqual(await batchResponse.json(), { offsets: { [created.id]: 5 } });

  const completed = await handle(new Request(`https://uploads.example/v1/uploads/${created.id}/complete`, {
    method: "POST",
  }));
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { id: created.id, text: "hello" });
});

test("custom service reports malformed protocol bodies as public 400 errors", async () => {
  const service = createUploadService({
    async createUpload() {},
    async resolveUpload() {},
    async writePart() {},
    async completeUpload() {},
    async removeUpload() {},
  });
  await assert.rejects(
    service.batch({}, new Uint8Array([1, 2, 3])),
    (error) => error instanceof UploadHttpError && error.status === 400,
  );
});
