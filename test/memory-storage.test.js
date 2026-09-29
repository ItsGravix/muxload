import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/memory-storage.js';
import { createUploadService } from '../src/server.js';
import { encodeBatch } from '../src/protocol.js';

test('memory storage resumes, isolates owners, finalizes once and releases capacity', async () => {
  let calls = 0;
  const storage = createMemoryStorage({ owner: (context) => context, maxFileBytes: 4, maxTotalBytes: 4,
    finalize: (_, upload) => { calls++; assert.deepEqual([...upload.bytes], [1, 2, 3, 4]); return { saved: true }; } });
  const service = createUploadService({ storage });
  const spec = { name: 'test', size: 4, metadata: {} };
  const { id } = await service.create('alice', spec);
  await assert.rejects(service.status('bob', [id]), { status: 404 });
  await assert.rejects(service.create('alice', spec), { status: 507 });
  const send = async (offset, bytes) => {
    const batch = encodeBatch([{ id, offset, length: bytes.length, blob: new Blob([new Uint8Array(bytes)]) }]);
    return service.batch('alice', await batch.body.arrayBuffer());
  };
  await send(0, [1, 2]);
  await send(0, [1, 2]);
  assert.equal((await service.status('alice', [id])).offsets[id], 2);
  await assert.rejects(service.complete('alice', id), { status: 409 });
  await send(2, [3, 4]);
  assert.deepEqual(await service.complete('alice', id), { saved: true });
  await service.complete('alice', id);
  assert.equal(calls, 1);
  await service.remove('alice', id);
  await service.create('alice', spec);
});

test('memory limits and authentication apply before storing bytes', async () => {
  assert.throws(() => createMemoryStorage({ owner: () => 'a', maxTotalBytes: -1 }), TypeError);
  const service = createUploadService({ storage: createMemoryStorage({ owner: (c) => c, maxFileBytes: 1, maxUploads: 1 }) });
  await assert.rejects(service.create('', { name: 'a', size: 1, metadata: {} }), { status: 401 });
  await assert.rejects(service.create('a', { name: 'a', size: 2, metadata: {} }), { status: 413 });
  await service.create('a', { name: 'a', size: 0, metadata: {} });
  await assert.rejects(service.create('a', { name: 'b', size: 0, metadata: {} }), { status: 507 });
});
