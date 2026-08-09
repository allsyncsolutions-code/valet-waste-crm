// Offline-capable photo outbox.
//
// Photos taken in the field are held in an IndexedDB queue (NOT the device's
// camera roll) and drained to Supabase whenever the app is online. This lets a
// tech capture proof photos with no signal — they land in the stop-photos
// bucket + stop_photos table automatically once reception returns, even if
// that's a different session (IndexedDB persists across closes/refreshes).
//
// There is deliberately NO service worker / Background Sync API here: the drain
// runs while the dispatch app tab is open, which is when staff are actively
// working. True closed-app background sync would need a SW + PWA install and is
// out of scope.

import { uploadStopPhoto } from './photosData.js'

const DB_NAME = 'vw-outbox'
const STORE = 'photos'
const DB_VERSION = 1
const DRAIN_INTERVAL_MS = 30000 // covers flaky signal that doesn't fire `online`

// ---- tiny promise wrappers over the IndexedDB API we need ----

let dbPromise = null
function db() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'))
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const idb = req.result
      if (!idb.objectStoreNames.contains(STORE)) {
        idb.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(mode) {
  return db().then((idb) => idb.transaction(STORE, mode).objectStore(STORE))
}
function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function put(record) { await reqAsPromise((await tx('readwrite')).put(record)) }
async function del(id) { await reqAsPromise((await tx('readwrite')).delete(id)) }
async function allPending() {
  const store = await tx('readonly')
  const records = await reqAsPromise(store.getAll())
  return (records || []).filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)
}
async function countPending() {
  const store = await tx('readonly')
  const records = await reqAsPromise(store.getAll())
  return (records || []).filter((r) => r.status === 'pending')
}

// ---- subscriber registry (UI badges update live) ----

const listeners = new Set()
function notify() { listeners.forEach((cb) => { try { cb() } catch (e) {} }) }
export function subscribeOutbox(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// ---- the public API ----

export async function getOutboxCounts() {
  let pending = []
  try { pending = await countPending() } catch (e) { return { pending: 0, byStop: {} } }
  const byStop = {}
  for (const r of pending) byStop[r.stopId] = (byStop[r.stopId] || 0) + 1
  return { pending: pending.length, byStop }
}

// Capture a photo into the queue. The File (a Blob) is stored verbatim in IDB;
// nothing is written to the device's photo library. Returns the local record id
// so callers can show an immediate optimistic thumbnail if they like.
export async function queuePhoto({ stopId, file, gps }) {
  if (!stopId || !file) throw new Error('queuePhoto needs stopId + file')
  const record = {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2),
    stopId,
    blob: file, // File extends Blob; persists fine in IDB
    type: file.type || 'image/jpeg',
    name: file.name || 'photo.jpg',
    lat: gps ? gps.lat : null,
    lng: gps ? gps.lng : null,
    createdAt: Date.now(),
    attempts: 0,
    status: 'pending',
  }
  await put(record)
  notify()
  // Best-effort immediate drain (no-op effect if offline — it'll retry on the interval / online event).
  drainPhotoOutbox().catch(() => {})
  return record
}

let draining = false
// Drain the queue: upload each pending photo to Supabase, one at a time.
// Per-item isolation — one failing photo never blocks the rest. Failures bump
// `attempts` and stay pending for the next drain (reconnect / interval).
export async function drainPhotoOutbox() {
  if (draining) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  draining = true
  try {
    let pending = await allPending()
    for (const rec of pending) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break
      try {
        const gps = (rec.lat != null && rec.lng != null) ? { lat: rec.lat, lng: rec.lng } : null
        // Reconstruct a File so contentType/name carry through to storage.
        const file = new File([rec.blob], rec.name, { type: rec.type })
        await uploadStopPhoto(rec.stopId, file, gps)
        await del(rec.id) // success — remove from the queue
      } catch (e) {
        // Leave it pending; bump attempts so we can surface stuck items later.
        await put({ ...rec, attempts: (rec.attempts || 0) + 1 })
      }
    }
  } finally {
    draining = false
    notify()
  }
}

// ---- background plumbing: online event + periodic interval ----

let started = false
export function startOutbox() {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('online', () => drainPhotoOutbox().catch(() => {}))
  // Drain on startup (so a queue from a previous offline session uploads now).
  drainPhotoOutbox().catch(() => {})
  // Periodic retry covers intermittent signal that never fires `online`.
  setInterval(() => drainPhotoOutbox().catch(() => {}), DRAIN_INTERVAL_MS)
}
