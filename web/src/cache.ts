// A small IndexedDB cache for the trustless chain. Transactions never change; the pool state
// rows and event histories are cached so a refresh paints before the chain is read again.
// The page works without IndexedDB (private windows, old browsers) and simply reads live.
const DB = 'pools-trustless-cache';
const STORE = 'records';
let opening: Promise<IDBDatabase | undefined> | null = null;

function open(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  opening ??= new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB, 1); } catch { resolve(undefined); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
  return opening;
}

/** Read one value, or undefined when the cache has no such key. */
export async function cacheGet<T = unknown>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

/** Write one value. A failed write is not an error: the live read still serves the page. */
export async function cachePut(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    } catch { resolve(); }
  });
}

/** Whether a value is cached under `key`. */
export async function cacheHas(key: string): Promise<boolean> {
  return (await cacheGet(key)) !== undefined;
}

/** Remove every cached record and the database, for a full reset of this browser's app data. */
export async function cacheClear(): Promise<void> {
  const db = await open();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      } catch { resolve(); }
    });
    db.close();
  }
  opening = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Another tab still holds it; it deletes when that connection closes.
      request.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
