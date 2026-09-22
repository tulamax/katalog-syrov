// Офлайн-режим каталога. Менять CACHE_VERSION при каждом деплое css/js/index.html —
// иначе клиенты увидят старые файлы (stale-while-revalidate обновит их только к следующему открытию).
// Фото под тем же именем смены версии не требуют: кэш фото без версии, с фоновой ревалидацией.
const CACHE_VERSION = 'v2026-09-22-1';

// Origin tulamax.github.io общий с другими проектами — свои кэши узнаём по префиксу
const PREFIX = 'katalog-syrov-';
const PRECACHE = `${PREFIX}${CACHE_VERSION}`;
const IMAGES = `${PREFIX}images`;
const PRECACHE_FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/ui.js',
  'js/cart.js',
  'js/phone.js',
  'js/catalog.js',
  'js/config.js',
  'data/products.json',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(PRECACHE)
      // cache: 'reload' — мимо HTTP-кэша браузера, чтобы новая версия не набрала старых файлов
      .then((c) => c.addAll(PRECACHE_FILES.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith(PREFIX) && k !== PRECACHE && k !== IMAGES)
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Фото: свои images/* и любые запросы картинок (внешние https-фото тоже)
function isImage(req, url) {
  return req.destination === 'image' || /\/images\//.test(url.pathname);
}

// Кладём в кэш только полноценные ответы; opaque (внешние фото без CORS) отдаём как есть
function putIfOk(cache, key, res) {
  // Возвращаем промис записи, чтобы waitUntil дождался её, а отказ (квота, 206) не стал unhandled rejection
  if (!res || !res.ok) return res;
  return cache.put(key, res.clone()).then(() => res, () => res);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google-таблица — только сеть; кэш таблицы живёт в localStorage (catalog.js).
  if (url.hostname === 'docs.google.com') return;

  if (isImage(req, url)) {
    // Cache-first + фоновая ревалидация: обновлённое фото видно со второго открытия
    e.respondWith(
      caches.open(IMAGES).then((cache) => cache.match(req).then((hit) => {
        const refresh = fetch(req).then((res) => putIfOk(cache, req, res));
        if (!hit) return refresh;
        e.waitUntil(refresh.catch(() => {}));
        return hit;
      })),
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // Свои файлы: отдаём из кэша сразу, в фоне обновляем на следующий раз.
  // Ключ — pathname: навигация с query (?utm=…) читает precache, но не плодит записей.
  const key = url.pathname;
  e.respondWith(
    caches.open(PRECACHE).then((cache) => cache.match(key).then((cached) => {
      const fresh = fetch(req).then((res) => (url.search ? res : putIfOk(cache, key, res)));
      if (!cached) return fresh.catch(() => Response.error());
      e.waitUntil(fresh.catch(() => {}));
      return cached;
    })),
  );
});
