import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadService, UploadHttpError } from '../src/server.js';
import { encodeBatch } from '../src/protocol.js';

test('direct handlers await a custom consumer, recover failed writes and return an application result', async () => {
  // Application-owned processing state; no Muxload storage or assembled file.
  const record = { id: 'custom', size: 4, offset: 0, sum: 0 };
  let failWrite = true;
  let finishCalls = 0;
  let completed;
  let removed = false;
  const service = createUploadService({
    createUpload: async () => ({ ...record }),
    resolveUpload: async (context, id) => {
      if (context !== 'owner' || id !== record.id || removed) throw new UploadHttpError(404, 'Missing');
      return { ...record }; // Fresh records prove offsets are persisted by the application.
    },
    writePart: async (_, upload, bytes, offset) => {
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(offset, record.offset);
      await Promise.resolve();
      if (failWrite) { failWrite = false; throw new Error('Destination unavailable'); }
      record.sum += bytes.reduce((sum, byte) => sum + byte, 0);
      record.offset = offset + bytes.byteLength;
    },
    completeUpload: async () => {
      if (!completed) { finishCalls++; completed = { checksum: record.sum }; }
      return completed;
    },
    removeUpload: async () => { removed = true; },
  });
  await service.create('owner', { name: 'custom.bin', size: 4, metadata: {} });
  const send = async (offset, values) => {
    const encoded = encodeBatch([{ id: record.id, offset, length: values.length, blob: new Blob([new Uint8Array(values)]) }]);
    return service.batch('owner', await encoded.body.arrayBuffer());
  };
  await assert.rejects(send(0, [1, 2]), /Destination unavailable/);
  assert.equal((await service.status('owner', [record.id])).offsets.custom, 0);
  await send(0, [1, 2]);
  await send(0, [1, 2]); // Lost-response retry must not repeat processing.
  assert.equal(record.sum, 3);
  await assert.rejects(service.complete('owner', record.id), { status: 409 });
  await send(2, [3, 4]);
  assert.deepEqual(await service.complete('owner', record.id), { checksum: 10 });
  await service.complete('owner', record.id);
  assert.equal(finishCalls, 1);
  await service.remove('owner', record.id);
  await assert.rejects(service.status('owner', [record.id]), { status: 404 });
});
