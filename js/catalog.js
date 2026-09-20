// Источник данных каталога: products.json → (опционально) Google-таблица.
// Парсер CSV, нормализация строк в единую модель товара (SPEC §2, §10), кэш листа.
import { CONFIG } from './config.js';

const CACHE_KEY = 'catalog:sheet';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SHEET_TIMEOUT_MS = 6000;

/**
 * Парсер CSV по RFC 4180: кавычки, запятые и переводы строк внутри поля,
 * `""` как экранированная кавычка, BOM в начале, `\r\n` / `\n` / `\r`.
 * Кавычка внутри незакавыченного поля («5" диск») — обычный символ.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // `""` → `"`
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    // Режим кавычек только в начале поля; иначе кавычка — часть значения
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += (ch === '\r' && s[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  // Последняя запись без завершающего перевода строки; пустой хвост после «\n» не запись
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Заголовок таблицы → поле модели; регистр и пробелы игнорируются (SPEC §2.3)
const HEADER_MAP = {
  id: 'id',
  'название': 'name',
  'категория': 'category',
  'описание': 'description',
  'ценаза100г': 'price',
  'цена': 'price',
  'вналичии': 'available',
  'фото': 'photo',
  'порядок': 'sort',
};

const normHeader = (h) => String(h ?? '').toLowerCase().replace(/\s+/g, '');

/** Русское название категории по коду; для неизвестного кода — сам код. */
export function categoryLabel(code, categories) {
  return (categories && categories[code]) || String(code ?? '');
}

// Код категории по коду или русскому названию без учёта регистра; null — не распознано
function resolveCategory(raw, categories) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return null;
  for (const [code, label] of Object.entries(categories || {})) {
    if (v === code.toLowerCase() || v === String(label).toLowerCase()) return code;
  }
  return null;
}

// Число из строки с разделителями по правилу SPEC §10: запятая — десятичный разделитель,
// только если после неё 1–2 цифры и точек нет; иначе запятая/точка между группами
// по 3 цифры — разделитель тысяч. «1.250,50» / «1,250.50» → последний разделитель десятичный.
// null — не число.
function parseDecimal(body) {
  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');
  let intPart = body;
  let frac = '';
  const splitAt = (pos) => { intPart = body.slice(0, pos); frac = body.slice(pos + 1); };
  if (lastComma >= 0 && lastDot >= 0) {
    splitAt(Math.max(lastComma, lastDot));
  } else if (lastComma >= 0) {
    const after = body.length - lastComma - 1;
    if (after >= 1 && after <= 2) splitAt(lastComma);
  } else if (lastDot >= 0) {
    // «1.250» — тысячи, «1250.5» / «1250.50» — копейки
    if (!/^\d{1,3}(\.\d{3})+$/.test(body)) splitAt(lastDot);
  }
  if (!/^\d+$/.test(intPart) && !/^\d{1,3}([.,]\d{3})+$/.test(intPart)) return null;
  if (!/^\d*$/.test(frac)) return null;
  const n = Number(intPart.replace(/[.,]/g, '') + (frac ? `.${frac}` : ''));
  return Number.isFinite(n) ? n : null;
}

// Цена: пусто, 0, отрицательная, «—», «по запросу» → null; «1 250», «1,250», «1250,50»,
// «1.250,50», «1 250 ₽», «1250 руб.» → число; буквы после очистки («1e3», «abc») → null + warn
function parsePrice(raw, where) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v || /запрос/.test(v) || /^[-—–]+$/.test(v)) return null;
  const cleaned = v.replace(/₽|руб\.?|р\.?|rub\.?/g, '').replace(/\s/g, '');
  if (!cleaned) return null;
  const m = cleaned.match(/^(-?)([\d.,]+)$/);
  const n = m ? parseDecimal(m[2]) : null;
  if (n === null) {
    console.warn(`[catalog] ${where}: непонятная цена «${raw}» → «по запросу»`);
    return null;
  }
  return m[1] || n <= 0 ? null : n;
}

const AVAILABLE_YES = ['', 'да', 'yes', '1', 'true', '+', 'есть'];
const AVAILABLE_NO = ['нет', 'no', '0', 'false', '-'];

// Наличие: пусто/да/yes/1/true/+/есть → true; нет/no/0/false/- → false;
// любое другое непустое значение → false + warn (безопаснее для продавца)
function parseAvailable(raw, where) {
  if (typeof raw === 'boolean') return raw;
  const v = String(raw ?? '').trim().toLowerCase();
  if (AVAILABLE_YES.includes(v)) return true;
  if (!AVAILABLE_NO.includes(v)) {
    console.warn(`[catalog] ${where}: непонятное значение «В наличии»: «${raw}» → «нет в наличии»`);
  }
  return false;
}

function parseId(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseSort(raw, fallback) {
  const v = String(raw ?? '').trim();
  if (!v) return fallback;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

// Общая сборка товара из «сырых» полей; null — строка непригодна
function buildProduct(raw, position, categories, seen, where) {
  const id = parseId(raw.id);
  const name = String(raw.name ?? '').trim();
  if (id === null || !name) {
    console.warn(`[catalog] ${where}: пропущена строка без id или названия`);
    return null;
  }
  if (seen.has(id)) {
    console.warn(`[catalog] ${where}: дубликат id=${id}, взята первая строка`);
    return null;
  }
  seen.add(id);
  const tag = `${where}, id=${id}`;
  let category = resolveCategory(raw.category, categories);
  if (category === null) {
    // Неизвестная категория не должна прятать товар: показываем его в первой категории
    category = Object.keys(categories || {})[0] || 'special';
    console.warn(`[catalog] ${tag}: неизвестная категория «${raw.category ?? ''}» → «${category}»`);
  }
  const photo = String(raw.photo ?? '').trim();
  return {
    id,
    name,
    category,
    description: String(raw.description ?? '').trim(),
    price: parsePrice(raw.price, tag),
    available: parseAvailable(raw.available, tag),
    photo: photo || `images/${id}.jpg`,
    sort: parseSort(raw.sort, position),
  };
}

// Сортировка по sort; при равенстве — порядок строк источника
function sortProducts(list) {
  return list
    .map((p, i) => [p, i])
    .sort((a, b) => (a[0].sort - b[0].sort) || (a[1] - b[1]))
    .map(([p]) => p);
}

/**
 * Строки таблицы (первая — заголовки) → массив товаров, отсортированный по sort.
 * Нераспознанный заголовок → warn (один раз на загрузку).
 * @param {string[][]} rows
 * @param {Record<string,string>} categories  {code: 'Русское название'}
 */
export function normalizeSheetRows(rows, categories) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const cols = rows[0].map((h) => {
    const key = HEADER_MAP[normHeader(h)] || null;
    if (!key && String(h ?? '').trim()) console.warn(`[catalog] нераспознанный заголовок колонки «${h}» — колонка пропущена`);
    return key;
  });
  const seen = new Set();
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.every((c) => String(c).trim() === '')) continue; // пустая строка
    const raw = {};
    cols.forEach((key, c) => { if (key && raw[key] === undefined) raw[key] = cells[c]; });
    const p = buildProduct(raw, r, categories, seen, `строка ${r + 1}`);
    if (p) out.push(p);
  }
  return sortProducts(out);
}

/**
 * Товары из products.json (или из кэша) → проверенные объекты с дефолтами, по sort.
 * @param {unknown[]} list
 * @param {Record<string,string>} categories
 */
export function normalizeProducts(list, categories) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const p = buildProduct(item, i + 1, categories, seen, `products[${i}]`);
    if (p) out.push(p);
  });
  return sortProducts(out);
}

// Пустой sheetName → параметр sheet не передаётся: Google отдаёт первый лист
function sheetUrl(config) {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(config.sheetId)}/gviz/tq?tqx=out:csv`;
  const name = String(config.sheetName ?? '').trim();
  return name ? `${base}&sheet=${encodeURIComponent(name)}` : base;
}

// Кэш листа в localStorage: {ts, sheetId, products}; null — нет, битый, чужой таблицы
// или старше TTL (возраст по модулю: сбитые часы не должны «замораживать» кэш)
function readCache(storage, categories, sheetId) {
  if (!sheetId) return null;
  try {
    const raw = storage && storage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.sheetId !== sheetId || typeof data.ts !== 'number') return null;
    if (Math.abs(Date.now() - data.ts) >= CACHE_TTL_MS) return null;
    const products = normalizeProducts(data.products, categories);
    return products.length ? products : null;
  } catch {
    return null;
  }
}

function writeCache(storage, sheetId, products) {
  try {
    if (storage) storage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), sheetId, products }));
  } catch (e) {
    console.warn('[catalog] не удалось сохранить кэш таблицы', e);
  }
}

// Загрузка таблицы с таймаутом; возвращает товары или бросает
async function fetchSheet({ config, fetchImpl, storage, categories }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SHEET_TIMEOUT_MS);
  try {
    const res = await fetchImpl(sheetUrl(config), { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const products = normalizeSheetRows(parseCsv(await res.text()), categories);
    if (!products.length) throw new Error('в таблице нет ни одного валидного товара');
    writeCache(storage, config.sheetId, products);
    return products;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`таймаут ${SHEET_TIMEOUT_MS} мс`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Загружает каталог: products.json (или свежий кэш листа) — сразу, таблицу — в фоне.
 * Бросает только если не загрузился products.json.
 * @returns {Promise<{categories: Record<string,string>, products: object[], source: 'json'|'sheet-cache'}>}
 */
export async function loadCatalog({
  config = CONFIG,
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  onUpdate,
} = {}) {
  const res = await fetchImpl(new URL('../data/products.json', import.meta.url));
  if (!res.ok) throw new Error(`products.json: HTTP ${res.status}`);
  const json = await res.json();
  const categories = (json && typeof json.categories === 'object' && json.categories) || {};
  let products = normalizeProducts(json && json.products, categories);
  let source = 'json';

  const sheetId = config && typeof config.sheetId === 'string' ? config.sheetId.trim() : '';
  const cached = readCache(storage, categories, sheetId);
  if (cached) { products = cached; source = 'sheet-cache'; }

  if (sheetId) {
    // Не ждём: каталог уже показан, таблица обновит его через onUpdate.
    // Ошибка сети — warn; ошибка самого onUpdate (рендера) — отдельно, как error.
    fetchSheet({ config: { ...config, sheetId }, fetchImpl, storage, categories })
      .then(
        (list) => list,
        (e) => { console.warn('[catalog] таблица недоступна, показываем products.json:', e && e.message ? e.message : e); return null; },
      )
      .then((list) => { if (list && typeof onUpdate === 'function') onUpdate({ categories, products: list, source: 'sheet' }); })
      .catch((e) => console.error('[catalog] ошибка обработчика onUpdate', e));
  }
  return { categories, products, source };
}
