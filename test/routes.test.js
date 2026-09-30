import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { createServer } from "node:http";
import { createNodeUploadHandler } from "../src/node.js";
import { createUploadClient } from "../src/client.js";
import { createExpressUploadRouter, createFetchUploadHandler, UploadHttpError } from "../src/server.js";
import { uploadRoutes } from "../src/routes.js";

const routes = { create: "start", batch: "pieces", status: "progress", complete: ":id/finish", remove: ":id" };

for (const framework of ["Express", "Fetch", "Node", "Request object"]) {
  test(`${framework}: shared route paths support upload, lost replies, pause, resume and cancellation`, async (t) => {
    const records = new Map();
    const storage = {
      async createUpload(_context, spec) {
        const record = { id: crypto.randomUUID(), size: spec.size, offset: 0, bytes: Buffer.alloc(spec.size) };
        records.set(record.id, record);
        return record;
      },
      async resolveUpload(_context, id) {
        if (!records.has(id)) throw new UploadHttpError(404, "Missing upload.");
        return records.get(id);
      },
      async writePart(_context, record, bytes, offset) { record.bytes.set(bytes, offset); },
      async completeUpload(_context, record) { return { id: record.id }; },
      async removeUpload(_context, record) { records.delete(record.id); },
    };
    const nativeFetch = globalThis.fetch;
    const originalXHR = globalThis.XMLHttpRequest;
    let endpoint = "http://example.test/files";
    let dispatch;
    if (framework === "Express") {
      const app = express();
      app.use("/files", createExpressUploadRouter({ express, storage, routes }));
      const server = app.listen(0);
      await once(server, "listening");
      endpoint = `http://127.0.0.1:${server.address().port}/files`;
      dispatch = nativeFetch;
      t.after(() => { server.closeAllConnections(); server.close(); });
    } else if (framework === "Node") {
      const handle = createNodeUploadHandler({ basePath: "/files", storage, routes });
      const server = createServer(async (request, response) => {
        if (await handle(request, response)) return;
        response.end("Other application route");
      }).listen(0);
      await once(server, "listening");
      endpoint = `http://127.0.0.1:${server.address().port}/files`;
      dispatch = nativeFetch;
      t.after(() => { server.closeAllConnections(); server.close(); });
      assert.equal(await (await dispatch(endpoint.replace("/files", "/other"))).text(), "Other application route");
    } else {
      const handle = createFetchUploadHandler({ basePath: "/files", storage, routes });
      dispatch = (url, options) => {
        const request = new Request(url, options);
        return handle(framework === "Request object" ? {
          url: new URL(url).pathname + new URL(url).search,
          method: request.method, headers: request.headers, body: request.body,
        } : request);
      };
      assert.equal((await dispatch("http://example.test/start", { method: "POST" })).status, 404);
    }
    const seen = [];
    globalThis.fetch = async (url, options) => {
      seen.push(`${options.method} ${new URL(url).pathname}`);
      return dispatch(url, options);
    };
    let loseReply = true;
    // Exercise the real client scheduler and HTTP handlers; adapt XHR to Node fetch.
    globalThis.XMLHttpRequest = class {
      upload = {};
      headers = {};
      open(method, url) { this.method = method; this.url = url; }
      setRequestHeader(name, value) { this.headers[name] = value; }
      send(body) {
        void (async () => {
          try {
            const response = await globalThis.fetch(this.url, { method: this.method, headers: this.headers, body });
            this.status = response.status;
            this.response = await response.json();
            this.upload.onload?.();
            if (loseReply) { loseReply = false; this.onerror(); }
            else this.onload();
          } catch { this.onerror(); }
        })();
      }
      abort() { this.onabort?.(); }
    };
    t.after(() => { globalThis.fetch = nativeFetch; globalThis.XMLHttpRequest = originalXHR; });
    const client = createUploadClient({ endpoint, routes, retryDelays: [0] });
    let pausedId;
    const bytes = new Uint8Array(180_000).fill(71);
    const first = client.upload(new Blob([bytes]), { onProgress({ id, state }) {
      if (state === "queued") { pausedId = id; client.pause(id); }
    } });
    const second = await client.upload(new Blob(["second"]));
    assert.equal(client.resume(pausedId), true);
    const result = await first;
    assert.deepEqual(new Uint8Array(records.get(result.id).bytes), bytes);
    assert.equal(records.get(second.id).bytes.toString(), "second");
    const cancelled = client.upload(new Blob(["cancel"]), { onProgress({ id, state }) {
      if (state === "queued") client.cancel(id);
    } });
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(records.size, 2);
    assert.ok(seen.includes("POST /files/start"));
    assert.ok(seen.includes("POST /files/pieces"));
    assert.ok(seen.includes("GET /files/progress"));
    assert.ok(seen.some((entry) => entry.endsWith("/finish")));
    assert.ok(seen.some((entry) => entry.startsWith("DELETE /files/")));
    assert.equal(client.getState().activeUploads, 0);
  });
}

test("route settings catch typos and malformed upload ID paths early", () => {
  assert.throws(() => uploadRoutes({ typo: "pieces" }), /Unknown upload route/);
  assert.throws(() => uploadRoutes({ complete: "finish" }), /:id/);
  assert.throws(() => uploadRoutes({ batch: "../pieces" }), /relative path/);
  assert.throws(() => uploadRoutes({ remove: ":id/:id" }), /one :id/);
  assert.throws(() => uploadRoutes({ create: "pieces", batch: "pieces" }), /overlap/);
  assert.throws(() => uploadRoutes({ create: "start/finish", complete: ":id/finish" }), /overlap/);
  assert.equal(uploadRoutes({ batch: "pieces" }).create, "uploads");
});
