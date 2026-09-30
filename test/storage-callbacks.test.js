import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createUploadClient, UploadError } from "../src/client.js";
import { createUploadService, createServiceCallbacks } from "../src/server.js";
import { createStorageContainer } from "../src/storage.js";

test("request callbacks resume a committed batch after response loss and pause independently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "parcelweave-test-"));
  try {
    const finalizedReads = new Map();
    const storage = createStorageContainer({
      directory,
      async finalize(_context, upload) {
        const hash = createHash("sha256");
        let bytesRead = 0;
        let largestChunk = 0;
        for await (const chunk of upload.createReadStream({ highWaterMark: 32 * 1024 })) {
          hash.update(chunk);
          bytesRead += chunk.length;
          largestChunk = Math.max(largestChunk, chunk.length);
        }
        finalizedReads.set(upload.id, { bytesRead, largestChunk, hash: hash.digest("hex") });
        return { id: upload.id, complete: true };
      },
    });
    const service = createUploadService({ storage });
    let contextCalls = 0;
    const direct = createServiceCallbacks(service, { context: () => { contextCalls++; return "owner"; } });
    let dropped = false;
    const events = [];
    const client = createUploadClient({
      retryDelays: [0],
      onEvent(event) { events.push(event); },
      ...direct,
        async sendParts(entries, { onProgress }) {
          const result = await direct.sendParts(entries, { onProgress });
          if (!dropped) { dropped = true; throw new UploadError("Lost reply", { retryable: true }); }
          return result;
        },
    });
    let pausedId;
    let paused = false;
    const bytes = new Uint8Array(300_000).fill(71);
    const first = client.upload(new Blob([bytes]), { onProgress({ id, state }) {
      if (state === "queued") { pausedId = id; paused = client.pause(id); }
    } });
    const second = await client.upload(new Blob(["second"]));
    assert.equal(paused, true);
    assert.equal(client.getState().activeUploads, 1);
    assert.equal(client.resume(pausedId), true);
    const result = await first;
    assert.deepEqual(new Uint8Array(await readFile(path.join(directory, result.id))), bytes);
    assert.equal(finalizedReads.get(result.id).bytesRead, bytes.length);
    assert.ok(finalizedReads.get(result.id).largestChunk <= 32 * 1024);
    assert.equal(finalizedReads.get(result.id).hash, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(finalizedReads.get(second.id).bytesRead, 6);
    assert.equal(finalizedReads.get(second.id).hash, createHash("sha256").update("second").digest("hex"));
    assert.equal(events.filter((event) => event.type === "complete").length, 2);
    assert.ok(events.some((event) => event.type === "retry"));
    assert.deepEqual((await readdir(directory)).sort(), [result.id, second.id].sort());
    assert.deepEqual(await service.status(undefined, [result.id]), { offsets: { [result.id]: bytes.length } });
    assert.deepEqual(await service.status({ any: "context" }, [second.id]), { offsets: { [second.id]: 6 } });
    assert.deepEqual(await service.complete(undefined, result.id), result);
    assert.ok(contextCalls > 0);
    await direct.cancelUpload(second.id);
    await assert.rejects(direct.getUploadStatus([second.id]), { status: 404 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(direct.createUpload({ name: "cancelled", size: 0, metadata: {} }, { signal: controller.signal }), { name: "AbortError" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
