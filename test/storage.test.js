import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createUploadService } from "../src/server.js";
import { encodeBatch } from "../src/protocol.js";
import { createStorageContainer } from "../src/storage.js";

test("the upload service stores, reads, completes, and removes files", async () => {
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
    const bytes = new Uint8Array(300_000).fill(71);
    const first = await service.create(undefined, { name: "first.bin", size: bytes.length, metadata: {} });
    const secondBytes = new TextEncoder().encode("second");
    const second = await service.create(undefined, { name: "second.txt", size: secondBytes.length, metadata: {} });
    const encoded = encodeBatch([
      { id: first.id, offset: 0, length: bytes.length, blob: new Blob([bytes]) },
      { id: second.id, offset: 0, length: secondBytes.length, blob: new Blob([secondBytes]) },
    ]);
    await service.batch(undefined, new Uint8Array(await encoded.body.arrayBuffer()));
    const result = await service.complete(undefined, first.id);
    const secondResult = await service.complete(undefined, second.id);
    assert.deepEqual(new Uint8Array(await readFile(path.join(directory, result.id))), bytes);
    assert.equal(finalizedReads.get(result.id).bytesRead, bytes.length);
    assert.ok(finalizedReads.get(result.id).largestChunk <= 32 * 1024);
    assert.equal(finalizedReads.get(result.id).hash, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(finalizedReads.get(secondResult.id).bytesRead, 6);
    assert.equal(finalizedReads.get(secondResult.id).hash, createHash("sha256").update("second").digest("hex"));
    assert.deepEqual((await readdir(directory)).sort(), [result.id, secondResult.id].sort());
    assert.deepEqual(await service.status(undefined, [result.id]), { offsets: { [result.id]: bytes.length } });
    assert.deepEqual(await service.status({ any: "context" }, [secondResult.id]), { offsets: { [secondResult.id]: 6 } });
    assert.deepEqual(await service.complete(undefined, result.id), result);
    await service.remove(undefined, secondResult.id);
    await assert.rejects(service.status(undefined, [secondResult.id]), { status: 404 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
