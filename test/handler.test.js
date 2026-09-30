import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createUploadHandler } from "../src/server.js";
import { createNodeUploadHandler } from "../src/node.js";

function storage(onCreate) {
  return {
    createUpload: onCreate,
    async resolveUpload() {}, async writePart() {},
    async completeUpload() {}, async removeUpload() {},
  };
}

test("framework request objects preserve application context and reject oversized streamed JSON", async () => {
  const context = { application: "context" };
  let calls = 0;
  const handle = createUploadHandler({ basePath: "/files", storage: storage(async (received, spec) => {
    calls++;
    assert.equal(received, context);
    return { id: "example", size: spec.size, offset: 0 };
  }) });
  const response = await handle({
    url: "/files/uploads", method: "POST", headers: { "Content-Type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ name: "file", size: 0, metadata: {} })),
  }, context);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "example", offset: 0 });
  const oversized = await handle({
    url: "/files/uploads", method: "POST", headers: { "Content-Type": "application/json" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33 * 1024)); controller.close(); } }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(calls, 1);
});

test("Node adapter returns bounded errors and preserves unrelated request bodies", async (t) => {
  let calls = 0;
  const handle = createNodeUploadHandler({ basePath: "/files", storage: storage(async () => { calls++; }) });
  const server = createServer(async (request, response) => {
    if (await handle(request, response)) return;
    let text = "";
    for await (const chunk of request) text += chunk;
    response.end(text);
  }).listen(0);
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const other = await fetch(`${base}/other`, { method: "POST", body: "untouched" });
  assert.equal(await other.text(), "untouched");
  const wrongType = await fetch(`${base}/files/uploads`, { method: "POST", body: "not JSON" });
  assert.equal(wrongType.status, 415);
  await wrongType.arrayBuffer();
  const oversized = await fetch(`${base}/files/uploads`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(33 * 1024),
  });
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  const malformed = await fetch(`${base}/files/uploads`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken",
  });
  assert.equal(malformed.status, 400);
  await malformed.arrayBuffer();
  assert.equal(calls, 0);
});
