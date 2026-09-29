import assert from "node:assert/strict";
import test from "node:test";
import { decodeBatch, encodeBatch } from "../src/protocol.js";

test("round-trips pieces from several files", async () => {
  const encoded = encodeBatch([
    { id: "audio", offset: 12, length: 3, blob: new Blob(["abc"]) },
    { id: "image", offset: 4, length: 4, blob: new Blob(["wxyz"]) },
  ]);
  const decoded = decodeBatch(new Uint8Array(await encoded.body.arrayBuffer()));
  assert.deepEqual(decoded.entries.map(({ id, offset, length }) => ({ id, offset, length })), [
    { id: "audio", offset: 12, length: 3 },
    { id: "image", offset: 4, length: 4 },
  ]);
  assert.equal(Buffer.from(decoded.entries[0].bytes).toString(), "abc");
  assert.equal(Buffer.from(decoded.entries[1].bytes).toString(), "wxyz");
});

test("rejects duplicate ids and trailing bytes", async () => {
  const duplicate = encodeBatch([
    { id: "same", offset: 0, length: 1, blob: new Blob(["a"]) },
    { id: "same", offset: 0, length: 1, blob: new Blob(["b"]) },
  ]);
  const duplicateBytes = new Uint8Array(await duplicate.body.arrayBuffer());
  assert.throws(() => decodeBatch(duplicateBytes), /same upload twice/);

  const encoded = encodeBatch([{ id: "one", offset: 0, length: 1, blob: new Blob(["a"]) }]);
  const original = new Uint8Array(await encoded.body.arrayBuffer());
  const malformed = new Uint8Array(original.length + 1);
  malformed.set(original);
  assert.throws(() => decodeBatch(malformed), /trailing bytes/);
});
