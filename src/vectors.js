// 向量快取：同一段文字（同一個模型）只轉一次。
//
// 存在瀏覽器的 IndexedDB（不放進聊天檔，免得檔案變很大）。只是快取，丟了就重新轉。
// IndexedDB 打不開（被封鎖、私密模式）時只用記憶體。

import { LOG_PREFIX } from './util.js';
import { hashText } from './chat.js';
import { embedTexts } from './api/embed.js';

const DB_NAME = 'lovers_planner_vectors';
const STORE = 'vec';
const MAX_MEMORY = 5000;

const memory = new Map();
let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        try {
            const req = globalThis.indexedDB?.open(DB_NAME, 1);
            if (!req) return resolve(null);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
    return dbPromise;
}

function keyOf(model, text) {
    return `${model}|${text.length}|${hashText(text)}`;
}

async function dbGet(keys) {
    const db = await openDb();
    if (!db) return keys.map(() => undefined);
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readonly');
            const store = tx.objectStore(STORE);
            const out = new Array(keys.length);
            keys.forEach((k, i) => {
                const r = store.get(k);
                r.onsuccess = () => { out[i] = r.result; };
            });
            tx.oncomplete = () => resolve(out);
            tx.onerror = () => resolve(out);
        } catch (e) {
            resolve(keys.map(() => undefined));
        }
    });
}

async function dbPut(entries) {
    const db = await openDb();
    if (!db || !entries.length) return;
    try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const [k, v] of entries) store.put(v, k);
    } catch (e) {
        console.warn(LOG_PREFIX, '向量快取寫入失敗', e);
    }
}

function remember(k, v) {
    if (memory.size >= MAX_MEMORY) memory.delete(memory.keys().next().value);
    memory.set(k, v);
}

/**
 * 取得每段文字的向量（和 texts 同順序）。快取裡沒有的才送去轉。
 * 回傳 { vectors, fetched }：fetched 是這次實際送出去轉的段數。
 */
export async function getVectors(cfg, texts) {
    const keys = texts.map((x) => keyOf(cfg.model, x));
    const out = keys.map((k) => memory.get(k));
    const missing = [];
    keys.forEach((k, i) => { if (!out[i]) missing.push(i); });
    if (missing.length) {
        const stored = await dbGet(missing.map((i) => keys[i]));
        missing.forEach((i, j) => {
            if (stored[j]) {
                out[i] = stored[j];
                remember(keys[i], stored[j]);
            }
        });
    }
    // 同一段文字可能出現好幾次，只送一次。
    const todo = [...new Set(keys.filter((k, i) => !out[i]))];
    if (todo.length) {
        const textOf = new Map(keys.map((k, i) => [k, texts[i]]));
        const vecs = await embedTexts(cfg, todo.map((k) => textOf.get(k)));
        const fresh = todo.map((k, j) => [k, Float32Array.from(vecs[j])]);
        for (const [k, v] of fresh) remember(k, v);
        dbPut(fresh);
        keys.forEach((k, i) => { if (!out[i]) out[i] = memory.get(k); });
    }
    return { vectors: out, fetched: todo.length };
}

/** 測試用：清掉記憶體裡的快取。 */
export function clearMemoryCache() {
    memory.clear();
}
