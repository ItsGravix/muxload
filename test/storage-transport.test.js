import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUploadClient, UploadError } from "../src/client.js";
import { createUploadService } from "../src/server.js";
import { createLocalStorage } from "../src/storage.js";
import { encodeBatch } from "../src/protocol.js";

test("endpoint-free transport resumes a committed batch after response loss and pauses independently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "parcelweave-test-"));
  try {
    const storage = createLocalStorage({ directory });
    const service = createUploadService({ storage });
    let dropped = false;
    const events = [];
    const client = createUploadClient({
      retryDelays: [0],
      onEvent(event) { events.push(event); },
      transport: {
        create: (spec) => service.create("owner", spec),
        async batch(entries, { onProgress }) {
          const encoded = encodeBatch(entries);
          onProgress(encoded.payloadBytes);
          const result = await service.batch("owner", await encoded.body.arrayBuffer());
          if (!dropped) { dropped = true; throw new UploadError("Lost reply", { retryable: true }); }
          return result;
        },
        status: (ids) => service.status("owner", ids),
        complete: (id) => service.complete("owner", id),
        remove: (id) => service.remove("owner", id),
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
    assert.deepEqual(new Uint8Array(await readFile(path.join(directory, result.id, "data"))), bytes);
    assert.equal(events.filter((event) => event.type === "complete").length, 2);
    assert.ok(events.some((event) => event.type === "retry"));
    const restarted = createUploadService({ storage: createLocalStorage({ directory }) });
    assert.deepEqual(await restarted.status(undefined, [result.id]), { offsets: { [result.id]: bytes.length } });
    assert.deepEqual(await restarted.status({ any: "context" }, [second.id]), { offsets: { [second.id]: 6 } });
    assert.deepEqual(await restarted.complete(undefined, result.id), result);
    const record = JSON.parse(await readFile(path.join(directory, result.id, "record.json"), "utf8"));
    assert.equal("owner" in record, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
