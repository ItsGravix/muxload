import { BATCH_CONTENT_TYPE, encodeBatch } from "./protocol.js";

const KiB = 1024;
const MiB = 1024 * KiB;

export class UploadError extends Error {
  constructor(message, { status = 0, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "UploadError";
    this.status = status;
    this.retryable = retryable;
  }
}

function clampInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function requestJson(method, url, { body, signal, headers, credentials, timeoutMs = 120_000 } = {}) {
  return fetch(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    credentials,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new UploadError(payload.error || `Upload request failed (${response.status}).`, {
        status: response.status,
        retryable: response.status === 408 || response.status === 409 || response.status === 425
          || response.status === 429 || response.status >= 500,
      });
    }
    return payload;
  });
}

function xhrBatch(url, encoded, { onProgress, bodyStallMs, responseStallMs, headers, credentials }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let watchdog;
    let bodyFinished = false;

    const fail = (message, status = xhr.status, retryable = true) => {
      clearTimeout(watchdog);
      reject(new UploadError(message, { status, retryable }));
    };
    const arm = (duration, message) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        xhr.abort();
        fail(message);
      }, duration);
    };

    xhr.open("POST", url, true);
    xhr.withCredentials = credentials === "include";
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, String(value));
    xhr.setRequestHeader("Content-Type", BATCH_CONTENT_TYPE);
    xhr.responseType = "json";
    xhr.timeout = 0;
    xhr.upload.onprogress = (event) => {
      onProgress(Math.max(0, Math.min(encoded.payloadBytes, event.loaded - encoded.headerBytes)));
      if (event.loaded < event.total) arm(bodyStallMs, "The upload stopped transmitting bytes.");
    };
    xhr.upload.onload = () => {
      bodyFinished = true;
      onProgress(encoded.payloadBytes);
      arm(responseStallMs, "The server did not finish the upload request.");
    };
    xhr.onerror = () => fail("The upload request lost its connection.");
    xhr.onabort = () => fail("The upload request was interrupted.");
    xhr.onload = () => {
      clearTimeout(watchdog);
      const payload = xhr.response && typeof xhr.response === "object" ? xhr.response : {};
      if (xhr.status >= 200 && xhr.status < 300) return resolve(payload);
      reject(new UploadError(payload.error || `Upload request failed (${xhr.status}).`, {
        status: xhr.status,
        retryable: xhr.status === 408 || xhr.status === 409 || xhr.status === 425
          || xhr.status === 429 || xhr.status >= 500,
      }));
    };
    arm(bodyStallMs, "The upload did not begin transmitting bytes.");
    xhr.send(encoded.body);

    // Some browsers do not emit upload.onload before the final load event.
    xhr.onreadystatechange = () => {
      if (!bodyFinished && xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED) {
        bodyFinished = true;
        onProgress(encoded.payloadBytes);
        arm(responseStallMs, "The server did not finish the upload request.");
      }
    };
  });
}

function retryDelay(attempt, delays) {
  return delays[Math.min(attempt, delays.length - 1)];
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createHttpTransport(options = {}) {
  if (typeof options.endpoint !== "string" || !options.endpoint.trim()) {
    throw new TypeError("createHttpTransport() requires an endpoint.");
  }
  const endpoint = options.endpoint.replace(/\/$/, "");
  const configuredRoutes = options.routes ?? {};
  if (!configuredRoutes || typeof configuredRoutes !== "object" || Array.isArray(configuredRoutes)) {
    throw new TypeError("routes must be an object.");
  }
  const routeDefaults = {
    create: () => "uploads",
    batch: () => "batches",
    status: (ids) => `status?ids=${ids.map(encodeURIComponent).join(",")}`,
    complete: (id) => `uploads/${encodeURIComponent(id)}/complete`,
    remove: (id) => `uploads/${encodeURIComponent(id)}`,
  };
  const route = (name, value) => {
    const configured = configuredRoutes[name];
    const path = typeof configured === "function"
      ? configured(value)
      : configured ?? routeDefaults[name](value);
    if (typeof path !== "string" || !path) throw new TypeError(`routes.${name} must resolve to a URL string.`);
    return /^[a-z][a-z\d+.-]*:\/\//i.test(path) ? path : `${endpoint}/${path.replace(/^\/+/, "")}`;
  };
  const responseStallMs = options.responseStallMs ?? 120_000;
  const headers = async () => typeof options.headers === "function" ? await options.headers() : options.headers ?? {};
  const json = async (method, name, value, body, signal) => {
    try {
      return await requestJson(method, route(name, value), { body, signal, headers: await headers(), credentials: options.credentials, timeoutMs: responseStallMs });
    } catch (error) {
      if (error instanceof UploadError || signal?.aborted) throw error;
      throw new UploadError("Upload connection failed.", { retryable: true, cause: error });
    }
  };
  return {
    create: (spec, { signal } = {}) => json("POST", "create", null, spec, signal),
    async batch(entries, { onProgress }) {
      return xhrBatch(route("batch"), encodeBatch(entries), { onProgress, headers: await headers(), credentials: options.credentials, bodyStallMs: options.bodyStallMs ?? 600_000, responseStallMs });
    },
    status: (ids) => json("GET", "status", ids),
    complete: (id) => json("POST", "complete", id, {}),
    remove: (id) => json("DELETE", "remove", id),
  };
}

export function createUploadClient(options = {}) {
  const transport = options.transport;
  if (!transport) {
    throw new TypeError("createUploadClient() requires a transport. Use createHttpUploadClient() for HTTP uploads.");
  }
  for (const method of ["create", "batch", "status", "complete", "remove"]) {
    if (typeof transport[method] !== "function") throw new TypeError(`transport.${method} must be a function.`);
  }
  const event = (type, record, extra = {}) => { try { options.onEvent?.({ type, id: record?.id, ...extra }); } catch {} };
  const minBatchBytes = clampInteger(options.minBatchBytes ?? 128 * KiB, 16 * KiB, 100 * MiB, "minBatchBytes");
  const maxBatchBytes = clampInteger(options.maxBatchBytes ?? 4 * MiB, minBatchBytes, 100 * MiB, "maxBatchBytes");
  const minPartBytes = clampInteger(options.minPartBytes ?? 16 * KiB, 1024, minBatchBytes, "minPartBytes");
  const maxFilesPerBatch = clampInteger(options.maxFilesPerBatch ?? 8, 1, 64, "maxFilesPerBatch");
  const maxConcurrentRequests = clampInteger(options.maxConcurrentRequests ?? 3, 1, 8, "maxConcurrentRequests");
  const retryDelays = options.retryDelays ?? [500, 1_000, 2_000, 5_000, 10_000, 20_000];
  const fastRequestMs = options.fastRequestMs ?? 2_000;
  const growthSuccesses = options.growthSuccesses ?? 4;
  const concurrencySuccesses = options.concurrencySuccesses ?? 8;
  const records = new Map();
  let cursor = 0;
  let activeRequests = 0;
  let currentBatchBytes = minBatchBytes;
  let currentConcurrency = 1;
  let fastSuccesses = 0;
  let pumpQueued = false;
  let prepared;

  const prepare = () => {
    if (!options.prepare) return Promise.resolve();
    prepared ??= Promise.resolve().then(options.prepare).catch((error) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  };

  const emit = (record, sent, state = "uploading") => {
    const safeSent = Math.max(record.displayed, Math.min(record.size, sent));
    record.displayed = state === "complete" ? record.size : Math.min(safeSent, Math.max(0, record.size - 1));
    try { record.onProgress?.({
      id: record.id,
      file: record.file,
      bytesUploaded: record.displayed,
      bytesConfirmed: record.offset,
      totalBytes: record.size,
      percentage: record.size ? Math.floor((record.displayed / record.size) * 100) : 100,
      state,
    }); } catch {}
  };

  const readyRecords = () => [...records.values()].filter((record) =>
    !record.paused && !record.inFlight && !record.finishing && !record.cancelled && !record.settled && record.offset < record.size);

  const buildBatch = () => {
    const ready = readyRecords();
    if (!ready.length) return null;
    const count = Math.min(maxFilesPerBatch, ready.length, Math.max(1, Math.floor(currentBatchBytes / minPartBytes)));
    const selected = Array.from({ length: count }, (_, index) => ready[(cursor + index) % ready.length]);
    cursor = (cursor + count) % Math.max(1, ready.length);
    let available = currentBatchBytes;
    const entries = [];

    for (let index = 0; index < selected.length; index += 1) {
      const record = selected[index];
      const remainingSlots = selected.length - index;
      const fairShare = Math.max(1, Math.floor(available / remainingSlots));
      const length = Math.min(record.size - record.offset, fairShare);
      record.inFlight = true;
      entries.push({ record, id: record.id, offset: record.offset, length, blob: record.file.slice(record.offset, record.offset + length) });
      available -= length;
    }
    return entries;
  };

  const distributeProgress = (entries, payloadLoaded) => {
    let consumed = payloadLoaded;
    for (const entry of entries) {
      const sent = Math.min(entry.length, Math.max(0, consumed));
      emit(entry.record, entry.offset + sent);
      consumed -= sent;
    }
  };

  const reconcile = async (entries) => {
    const ids = entries.map((entry) => entry.id);
    try {
      const payload = await transport.status(ids);
      for (const entry of entries) {
        const confirmed = payload.offsets?.[entry.id];
        if (Number.isSafeInteger(confirmed) && confirmed >= entry.record.offset && confirmed <= entry.record.size) {
          entry.record.offset = confirmed;
          emit(entry.record, confirmed);
        }
      }
    } catch {
      // An ambiguous failure is safe: retrying from the last known offset makes the
      // server either accept the piece or return its newer confirmed offset.
    }
  };

  const finishRecord = async (record) => {
    if (record.finishing || record.settled || record.cancelled || record.paused || record.offset !== record.size) return;
    record.finishing = true;
    for (let attempt = 0; !record.cancelled; attempt += 1) {
      try {
        const result = await transport.complete(record.id);
        if (record.cancelled) return;
        record.settled = true;
        record.finishing = false;
        records.delete(record.localId);
        emit(record, record.size, "complete");
        record.resolve(result);
        event("complete", record, { result });
        return;
      } catch (error) {
        if (!error.retryable) {
          event("error", record, { error });
          record.settled = true;
          record.finishing = false;
          records.delete(record.localId);
          record.reject(error);
          return;
        }
        event("retry", record, { error });
        await wait(retryDelay(attempt, retryDelays));
      }
    }
  };

  const schedulePump = () => {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(() => {
      pumpQueued = false;
      pump();
    });
  };

  const runBatch = async (entries) => {
    activeRequests += 1;
    const startedAt = performance.now();
    let succeeded = false;
    try {
      const result = await transport.batch(entries.map(({ id, offset, length, blob }) => ({ id, offset, length, blob })), {
        onProgress: (loaded) => distributeProgress(entries, loaded),
      });
      for (const entry of entries) {
        const confirmed = result.offsets?.[entry.id];
        if (!Number.isSafeInteger(confirmed) || confirmed < entry.offset + entry.length || confirmed > entry.record.size) {
          throw new UploadError("The server returned an invalid confirmed offset.", { retryable: true });
        }
        entry.record.offset = confirmed;
        entry.record.attempt = 0;
        emit(entry.record, confirmed);
      }
      succeeded = true;
      if (performance.now() - startedAt <= fastRequestMs) fastSuccesses += 1;
      else fastSuccesses = 0;
      if (fastSuccesses >= growthSuccesses && currentBatchBytes < maxBatchBytes) {
        currentBatchBytes = Math.min(maxBatchBytes, currentBatchBytes * 2);
        fastSuccesses = 0;
      } else if (fastSuccesses >= concurrencySuccesses && currentConcurrency < maxConcurrentRequests) {
        currentConcurrency += 1;
        fastSuccesses = 0;
      }
    } catch (error) {
      for (const entry of entries) event(error.retryable ? "retry" : "error", entry.record, { error });
      await reconcile(entries);
      currentBatchBytes = Math.max(minBatchBytes, Math.floor(currentBatchBytes / 2));
      currentConcurrency = Math.max(1, currentConcurrency - 1);
      fastSuccesses = 0;
      for (const entry of entries) entry.record.attempt += 1;
      if (entries.some((entry) => !entry.record.cancelled && !error.retryable)) {
        for (const entry of entries) {
          if (!entry.record.cancelled && !entry.record.settled) {
            entry.record.settled = true;
            records.delete(entry.record.localId);
            entry.record.reject(error);
          }
        }
      } else {
        const attempt = Math.max(...entries.map((entry) => entry.record.attempt));
        await wait(retryDelay(attempt, retryDelays));
      }
    } finally {
      for (const entry of entries) entry.record.inFlight = false;
      activeRequests -= 1;
      for (const entry of entries) {
        if (entry.record.cancelled) void removeRecord(entry.record);
        else void finishRecord(entry.record);
      }
      schedulePump();
    }
  };

  function pump() {
    while (activeRequests < currentConcurrency) {
      const entries = buildBatch();
      if (!entries) break;
      void runBatch(entries);
    }
  }

  async function removeRecord(record) {
    if (record.removing || record.settled || record.inFlight) return;
    record.removing = true;
    try {
      if (record.id) await transport.remove(record.id);
    } catch {
      // Cancellation is local-first. Server cleanup may also expire abandoned sessions.
    } finally {
      record.settled = true;
      records.delete(record.localId);
      record.reject(new DOMException("The upload was cancelled.", "AbortError"));
      schedulePump();
    }
  }

  async function upload(file, { metadata = {}, signal, onProgress } = {}) {
    if (!(file instanceof Blob)) throw new TypeError("upload() expects a File or Blob.");
    if (signal?.aborted) throw signal.reason ?? new DOMException("The upload was cancelled.", "AbortError");
    const localId = crypto.randomUUID();
    let resolve;
    let reject;
    const done = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    done.catch(() => {});
    const record = {
      localId, file, size: file.size, metadata, onProgress, resolve, reject,
      id: null, offset: 0, displayed: 0, attempt: 0, inFlight: false,
      finishing: false, removing: false, cancelled: false, settled: false,
    };

    const abort = () => {
      record.cancelled = true;
      if (record.id && !record.inFlight) void removeRecord(record);
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      await prepare();
      const created = await transport.create({
          name: file.name || "upload.bin",
          size: file.size,
          type: file.type || "application/octet-stream",
          metadata,
      }, { signal });
      record.id = created.id;
      record.offset = created.offset ?? 0;
      records.set(localId, record);
      event("created", record);
      if (record.cancelled) { void removeRecord(record); return await done; }
      emit(record, record.offset, "queued");
      if (record.size === 0) void finishRecord(record);
      else schedulePump();
      return await done;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    upload,
    pause(id) {
      const record = [...records.values()].find((item) => item.id === id);
      if (!record || record.finishing) return false;
      record.paused = true;
      event("paused", record);
      return true;
    },
    resume(id) {
      const record = [...records.values()].find((item) => item.id === id);
      if (!record || record.cancelled) return false;
      record.paused = false;
      event("resumed", record);
      void finishRecord(record);
      schedulePump();
      return true;
    },
    cancel(id) {
      const record = [...records.values()].find((item) => item.id === id);
      if (!record) return false;
      record.cancelled = true;
      event("cancelled", record);
      void removeRecord(record);
      return true;
    },
    getState() {
      return {
        activeUploads: records.size,
        activeRequests,
        batchBytes: currentBatchBytes,
        concurrency: currentConcurrency,
      };
    },
  };
}

export function createHttpUploadClient(options = {}) {
  return createUploadClient({ ...options, transport: createHttpTransport(options) });
}
