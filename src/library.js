// Saved songs: the audio file and its chart are kept in IndexedDB,
// so songs you add are still there after a reload.

const DB = 'kysync';
const STORE = 'songs';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  }));
}

/** { id, title, chart (raw JSON), audio (Blob), added } */
export const library = {
  async all() {
    try {
      const rows = await tx('readonly', (s) => s.getAll());
      return (rows || []).sort((a, b) => a.added - b.added);
    } catch (err) {
      console.warn('Song library unavailable:', err);
      return [];
    }
  },
  save(entry) {
    return tx('readwrite', (s) => s.put(entry)).catch((err) => console.warn('Could not save song:', err));
  },
  remove(id) {
    return tx('readwrite', (s) => s.delete(id)).catch(() => {});
  },
};
