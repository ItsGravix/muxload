const MAGIC = new Uint8Array([0x4d, 0x55, 0x58, 0x31]);
const PREFIX_BYTES = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const BATCH_CONTENT_TYPE = "application/vnd.parcelweave.batch";
export const MAX_UPLOAD_ID_LENGTH = 200;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

export function normalizeUploadId(value) {
  if (typeof value !== "string" || !value || value.length > MAX_UPLOAD_ID_LENGTH || !UPLOAD_ID_PATTERN.test(value)) {
    throw new TypeError("Upload ids must be URL-safe strings of 1 to 200 characters.");
  }
  return value;
}

function assertSafeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

function normalizeEntry(entry) {
  if (!entry) throw new TypeError("Each batch entry needs an id.");
  assertSafeNonNegativeInteger(entry.offset, "entry.offset");
  assertSafeNonNegativeInteger(entry.length, "entry.length");
  return { id: normalizeUploadId(entry.id), offset: entry.offset, length: entry.length };
}

export function encodeBatch(entries) {
  const normalized = entries.map(normalizeEntry);
  const manifestBytes = encoder.encode(JSON.stringify({ entries: normalized }));
  const prefix = new Uint8Array(PREFIX_BYTES + manifestBytes.byteLength);
  prefix.set(MAGIC, 0);
  new DataView(prefix.buffer).setUint32(4, manifestBytes.byteLength, false);
  prefix.set(manifestBytes, PREFIX_BYTES);

  const pieces = entries.map((entry, index) => {
    const normalizedEntry = normalized[index];
    const piece = entry.blob ?? entry.bytes;
    if (!(piece instanceof Blob) || piece.size !== normalizedEntry.length) {
      throw new TypeError(`Entry ${normalizedEntry.id} must provide a Blob matching its length.`);
    }
    return piece;
  });

  return {
    body: new Blob([prefix, ...pieces], { type: BATCH_CONTENT_TYPE }),
    headerBytes: prefix.byteLength,
    payloadBytes: normalized.reduce((sum, entry) => sum + entry.length, 0),
    manifest: normalized,
  };
}

export function decodeBatch(buffer, { maxEntries = 64, maxManifestBytes = 64 * 1024 } = {}) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (bytes.byteLength < PREFIX_BYTES || !MAGIC.every((value, index) => bytes[index] === value)) {
    throw new TypeError("Invalid Parcelweave batch signature.");
  }

  const manifestLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(4, false);
  if (manifestLength > maxManifestBytes || PREFIX_BYTES + manifestLength > bytes.byteLength) {
    throw new TypeError("Invalid Parcelweave manifest length.");
  }

  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + manifestLength)));
  } catch {
    throw new TypeError("Invalid Parcelweave manifest JSON.");
  }

  if (!Array.isArray(parsed?.entries) || parsed.entries.length === 0 || parsed.entries.length > maxEntries) {
    throw new TypeError("Invalid Parcelweave entry count.");
  }

  const seen = new Set();
  let cursor = PREFIX_BYTES + manifestLength;
  const entries = parsed.entries.map((entry) => {
    const normalized = normalizeEntry(entry);
    if (seen.has(normalized.id)) throw new TypeError("A batch cannot contain the same upload twice.");
    seen.add(normalized.id);
    const end = cursor + normalized.length;
    if (end > bytes.byteLength) throw new TypeError("Batch payload is shorter than its manifest.");
    const result = { ...normalized, bytes: bytes.subarray(cursor, end) };
    cursor = end;
    return result;
  });

  if (cursor !== bytes.byteLength) throw new TypeError("Batch has unlisted trailing bytes.");
  return { entries, headerBytes: PREFIX_BYTES + manifestLength };
}
