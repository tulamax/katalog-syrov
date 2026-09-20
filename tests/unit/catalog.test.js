import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseCsv, normalizeSheetRows, normalizeProducts, loadCatalog, categoryLabel,
} from '../../js/catalog.js';
import { CONFIG } from '../../js/config.js';

const CATEGORIES = { hard: 'Твёрдые', blue: 'Голубые', soft: 'Мягкие', goat: 'Козий', special: 'С добавками' };
const HEADER = ['id', 'Название', 'Категория', 'Описание', 'Цена за 100 г', 'В наличии', 'Фото', 'Порядок'];

// Тесты нормализации намеренно подают битые строки — предупреждения глушим
let warnings = [];
const origWarn = console.warn;
beforeEach(() => { warnings = []; console.warn = (...a) => warnings.push(a.join(' ')); });
afterEach(() => { console.warn = origWarn; });

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('parseCsv', () => {
  test('простые строки, \\r\\n и \\n', () => {
    assert.deepEqual(parseCsv('a,b\r\nc,d\n1,2'), [['a', 'b'], ['c', 'd'], ['1', '2']]);
  });

  test('BOM в начале отбрасывается', () => {
    assert.deepEqual(parseCsv('﻿id,Название\n1,Сыр'), [['id', 'Название'], ['1', 'Сыр']]);
  });

  test('кавычки: запятая внутри поля и "" как кавычка', () => {
    assert.deepEqual(parseCsv('1,"Сыр, выдержанный","Он сказал ""да"""'),
      [['1', 'Сыр, выдержанный', 'Он сказал "да"']]);
  });

  test('перевод строки внутри кавычек не разбивает запись', () => {
    assert.deepEqual(parseCsv('1,"первая\r\nвторая",x\n2,y,z'),
      [['1', 'первая\r\nвторая', 'x'], ['2', 'y', 'z']]);
  });

  test('пустые поля и хвостовой перевод строки: пустая запись после последнего \\n не добавляется', () => {
    assert.deepEqual(parseCsv('a,,c\n,,\n'), [['a', '', 'c'], ['', '', '']]);
    assert.deepEqual(parseCsv('a,b\r\n'), [['a', 'b']]);
    assert.deepEqual(parseCsv('a,\n'), [['a', '']]);
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('x'), [['x']]);
  });

  test('одиночный \\r без \\n — разделитель строк', () => {
    assert.deepEqual(parseCsv('a,b\rc,d\r'), [['a', 'b'], ['c', 'd']]);
    assert.deepEqual(parseCsv('1,"x\ry"\r2,z'), [['1', 'x\ry'], ['2', 'z']]);
  });

  test('кавычка внутри незакавыченного поля — обычный символ', () => {
    assert.deepEqual(parseCsv('1,диск 5" ,x'), [['1', 'диск 5" ', 'x']]);
    assert.deepEqual(parseCsv('a"b,c'), [['a"b', 'c']]);
    assert.deepEqual(parseCsv('"a",b"c\n"d"'), [['a', 'b"c'], ['d']]);
  });
});

describe('normalizeSheetRows', () => {
  test('заголовки без учёта регистра и пробелов; базовый товар', () => {
    const rows = [
      ['ID', ' название ', 'КАТЕГОРИЯ', 'описание', 'цена за 100г', 'в наличии', 'ФОТО', 'порядок'],
      ['7', ' Landana 500 ', 'Твёрдые', ' Гауда ', '1 250', 'да', '', '3'],
    ];
    assert.deepEqual(normalizeSheetRows(rows, CATEGORIES), [{
      id: 7, name: 'Landana 500', category: 'hard', description: 'Гауда',
      price: 1250, available: true, photo: 'images/7.jpg', sort: 3,
    }]);
  });

  test('все варианты «В наличии»: явные «да» и «нет» без warning', () => {
    const yes = ['', 'да', 'Да', 'yes', 'YES', '1', 'true', 'TRUE', '+', '  да  ', 'есть', 'Есть'];
    const no = ['нет', 'Нет', 'no', 'NO', '0', 'false', 'FALSE', '-', ' нет '];
    const all = [...yes, ...no];
    const rows = [HEADER, ...all.map((v, i) => [String(i + 1), 'x', 'hard', '', '', v, '', ''])];
    const res = normalizeSheetRows(rows, CATEGORIES);
    assert.equal(res.length, all.length);
    res.forEach((p, i) => assert.equal(p.available, i < yes.length, `значение «${all[i]}»`));
    assert.equal(warnings.length, 0);
  });

  test('«В наличии»: любое другое непустое значение → false + warn с текстом и id строки', () => {
    const odd = ['—', 'мало', 'скоро', 'ok', 'y', 'n', '2'];
    const rows = [HEADER, ...odd.map((v, i) => [String(i + 101), 'x', 'hard', '', '', v, '', ''])];
    const res = normalizeSheetRows(rows, CATEGORIES);
    assert.equal(res.length, odd.length);
    res.forEach((p, i) => assert.equal(p.available, false, `значение «${odd[i]}»`));
    assert.equal(warnings.length, odd.length);
    odd.forEach((v, i) => {
      assert.ok(warnings[i].includes(`«${v}»`) && warnings[i].includes(`id=${i + 101}`), warnings[i]);
    });
  });

  test('все варианты цены по правилу §10 (без warning)', () => {
    const cases = [
      ['', null], ['0', null], ['0,00', null], ['—', null], ['-', null], ['–', null],
      ['по запросу', null], ['По запросу', null], ['-100', null], ['-1 250,50', null],
      ['1250', 1250], ['1 250', 1250], ['1\u00a0250', 1250], ['1,250', 1250], ['1.250', 1250],
      ['1250,50', 1250.5], ['1250,5', 1250.5], ['1 250,50', 1250.5], ['1.250,50', 1250.5],
      ['1,250.50', 1250.5], ['1250.5', 1250.5], ['1250.50', 1250.5],
      ['1 250 ₽', 1250], ['1250₽', 1250], ['1250 руб.', 1250], ['1250 руб', 1250], ['1 250 р.', 1250],
      ['12 000', 12000], ['1,250,000', 1250000], ['12,50', 12.5], ['550', 550],
    ];
    const rows = [HEADER, ...cases.map(([v], i) => [String(i + 1), 'x', 'hard', '', v, '', '', ''])];
    const res = normalizeSheetRows(rows, CATEGORIES);
    assert.equal(res.length, cases.length);
    res.forEach((p, i) => assert.equal(p.price, cases[i][1], `цена «${cases[i][0]}»`));
    assert.equal(warnings.length, 0);
  });

  test('цена с буквами или непонятными разделителями → null + warn с текстом', () => {
    const cases = ['1e3', 'abc', '12 руб 50 коп', '1,2,3', '1.2.3', '1,2500', '12 usd'];
    const rows = [HEADER, ...cases.map((v, i) => [String(i + 1), 'x', 'hard', '', v, '', '', ''])];
    const res = normalizeSheetRows(rows, CATEGORIES);
    assert.equal(res.length, cases.length);
    res.forEach((p, i) => assert.equal(p.price, null, `цена «${cases[i]}»`));
    assert.equal(warnings.length, cases.length);
    cases.forEach((v, i) => assert.ok(warnings[i].includes(`«${v}»`) && warnings[i].includes(`id=${i + 1}`), warnings[i]));
  });

  test('нераспознанный заголовок колонки → warn с его текстом один раз; колонка игнорируется', () => {
    const rows = [
      ['id', 'Название', 'Вес', 'Цена', ''],
      ['1', 'a', '200', '100', 'x'],
      ['2', 'b', '300', '200', 'y'],
    ];
    const res = normalizeSheetRows(rows, CATEGORIES);
    assert.deepEqual(res.map((p) => [p.id, p.price]), [[1, 100], [2, 200]]);
    const headerWarns = warnings.filter((w) => w.includes('заголовок'));
    assert.equal(headerWarns.length, 1, 'пустой заголовок не считается');
    assert.ok(headerWarns[0].includes('«Вес»'));
  });

  test('категория по русскому названию или коду без учёта регистра; неизвестная — fallback с warning', () => {
    const rows = [HEADER,
      ['1', 'a', 'голубые', '', '', '', '', ''],
      ['2', 'b', 'BLUE', '', '', '', '', ''],
      ['3', 'c', 'С добавками', '', '', '', '', ''],
      ['4', 'd', 'Неизвестно', '', '', '', '', ''],
    ];
    const res = normalizeSheetRows(rows, CATEGORIES);
    assert.deepEqual(res.map((p) => p.category), ['blue', 'blue', 'special', 'hard']);
    assert.ok(warnings.some((w) => w.includes('неизвестная категория')));
  });

  test('фото по умолчанию images/{id}.jpg, иначе как есть', () => {
    const rows = [HEADER,
      ['12', 'a', 'hard', '', '', '', '', ''],
      ['13', 'b', 'hard', '', '', '', 'https://example.com/p.jpg', ''],
      ['14', 'c', 'hard', '', '', '', ' images/custom.jpg ', ''],
    ];
    assert.deepEqual(normalizeSheetRows(rows, CATEGORIES).map((p) => p.photo),
      ['images/12.jpg', 'https://example.com/p.jpg', 'images/custom.jpg']);
  });

  test('порядок: явный «Порядок», пусто → порядок строк; результат отсортирован', () => {
    const rows = [HEADER,
      ['1', 'a', 'hard', '', '', '', '', '5'],
      ['2', 'b', 'hard', '', '', '', '', ''],
      ['3', 'c', 'hard', '', '', '', '', '1'],
    ];
    const res = normalizeSheetRows(rows, CATEGORIES);
    assert.deepEqual(res.map((p) => [p.id, p.sort]), [[3, 1], [2, 2], [1, 5]]);
  });

  test('строки без id или названия пропускаются с warning; дубликат id — первая строка', () => {
    const rows = [HEADER,
      ['', 'без id', 'hard', '', '', '', '', ''],
      ['5', '   ', 'hard', '', '', '', '', ''],
      ['abc', 'плохой id', 'hard', '', '', '', '', ''],
      ['6', 'первый', 'hard', '', '100', '', '', ''],
      ['6', 'второй', 'hard', '', '200', '', '', ''],
      ['', '', '', '', '', '', '', ''],
    ];
    const res = normalizeSheetRows(rows, CATEGORIES);
    assert.equal(res.length, 1);
    assert.equal(res[0].name, 'первый');
    assert.equal(res[0].price, 100);
    assert.ok(warnings.length >= 4);
  });

  test('только заголовок или пустой массив → 0 товаров', () => {
    assert.deepEqual(normalizeSheetRows([HEADER], CATEGORIES), []);
    assert.deepEqual(normalizeSheetRows([], CATEGORIES), []);
    assert.deepEqual(normalizeSheetRows(parseCsv(''), CATEGORIES), []);
  });

  test('CSV из Google в формате gviz разбирается целиком', () => {
    const csv = '﻿"id","Название","Категория","Описание","Цена за 100 г","В наличии","Фото","Порядок"\r\n'
      + '"43","Сантагюр","Голубые","Saint Agur, Овернь","1 250","","",""\r\n'
      + '"6","Landana 1000 дн","Твёрдые","Гауда ""1000 дней""","550","да","",""\r\n';
    const res = normalizeSheetRows(parseCsv(csv), CATEGORIES);
    assert.deepEqual(res.map((p) => [p.id, p.name, p.price, p.description]),
      [[43, 'Сантагюр', 1250, 'Saint Agur, Овернь'], [6, 'Landana 1000 дн', 550, 'Гауда "1000 дней"']]);
  });
});

describe('normalizeProducts', () => {
  test('реальный data/products.json: 53 валидных товара', async () => {
    const json = JSON.parse(await readFile(new URL('../../data/products.json', import.meta.url), 'utf8'));
    const res = normalizeProducts(json.products, json.categories);
    assert.equal(res.length, 53);
    assert.equal(new Set(res.map((p) => p.id)).size, 53);
    for (const p of res) {
      assert.ok(p.name && p.category in json.categories && typeof p.available === 'boolean');
      assert.equal(p.photo, `images/${p.id}.jpg`);
    }
    assert.deepEqual(res.map((p) => p.sort), [...res.map((p) => p.sort)].sort((a, b) => a - b));
    assert.equal(warnings.length, 0);
  });

  test('битые записи отбрасываются, дефолты подставляются, порядок по sort', () => {
    const res = normalizeProducts([
      { id: 2, name: 'B', category: 'hard', sort: 5 },
      { id: 1, name: 'A', category: 'Голубые', price: '1 100', available: 'нет', photo: '' },
      { id: 'x', name: 'нет id' },
      { id: 3, name: '' },
      null,
      { id: 2, name: 'дубль' },
    ], CATEGORIES);
    assert.deepEqual(res, [
      { id: 1, name: 'A', category: 'blue', description: '', price: 1100, available: false, photo: 'images/1.jpg', sort: 2 },
      { id: 2, name: 'B', category: 'hard', description: '', price: null, available: true, photo: 'images/2.jpg', sort: 5 },
    ]);
    assert.deepEqual(normalizeProducts(undefined, CATEGORIES), []);
  });

  test('categoryLabel', () => {
    assert.equal(categoryLabel('blue', CATEGORIES), 'Голубые');
    assert.equal(categoryLabel('unknown', CATEGORIES), 'unknown');
  });
});

describe('loadCatalog', () => {
  const JSON_BODY = { categories: CATEGORIES, products: [
    { id: 1, name: 'JSON A', category: 'hard', price: 100, available: true, photo: 'images/1.jpg', sort: 1 },
    { id: 2, name: 'JSON B', category: 'blue', price: null, available: true, photo: 'images/2.jpg', sort: 2 },
  ] };
  const SHEET_CSV = 'id,Название,Категория,Описание,Цена за 100 г,В наличии,Фото,Порядок\n1,Sheet A,hard,,200,да,,\n';

  // Заглушка fetch: products.json всегда отдаёт JSON_BODY, таблицу — по sheetResponse
  function makeFetch(sheetResponse) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (String(url).endsWith('data/products.json')) {
        return { ok: true, status: 200, json: async () => JSON_BODY };
      }
      return typeof sheetResponse === 'function' ? sheetResponse(opts) : sheetResponse;
    };
    return { fetchImpl, calls };
  }
  const okCsv = (text) => ({ ok: true, status: 200, text: async () => text });

  test('sheetId пустой → только products.json, source json', async () => {
    const { fetchImpl, calls } = makeFetch(null);
    const res = await loadCatalog({ config: { ...CONFIG, sheetId: '' }, fetchImpl, storage: memoryStorage() });
    assert.equal(res.source, 'json');
    assert.equal(res.products.length, 2);
    assert.deepEqual(res.categories, CATEGORIES);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/data/products.json'));
  });

  test('sheetName пустой → параметр sheet не передаётся (первый лист)', async () => {
    const { fetchImpl, calls } = makeFetch(okCsv(SHEET_CSV));
    await new Promise((resolve) => {
      loadCatalog({ config: { ...CONFIG, sheetId: 'ABC123', sheetName: '' }, fetchImpl, storage: memoryStorage(), onUpdate: resolve });
    });
    assert.equal(calls[1].url, 'https://docs.google.com/spreadsheets/d/ABC123/gviz/tq?tqx=out:csv');
  });

  test('таблица загрузилась → onUpdate с source sheet, кэш записан, URL по ТЗ', async () => {
    const { fetchImpl, calls } = makeFetch(okCsv(SHEET_CSV));
    const storage = memoryStorage();
    const config = { ...CONFIG, sheetId: 'ABC123', sheetName: 'Товары' };
    const updated = new Promise((resolve) => {
      loadCatalog({ config, fetchImpl, storage, onUpdate: resolve }).then((first) => {
        assert.equal(first.source, 'json');
        assert.equal(first.products[0].name, 'JSON A');
      });
    });
    const upd = await updated;
    assert.equal(upd.source, 'sheet');
    assert.deepEqual(upd.products.map((p) => p.name), ['Sheet A']);
    assert.deepEqual(upd.categories, CATEGORIES);
    assert.equal(calls[1].url,
      'https://docs.google.com/spreadsheets/d/ABC123/gviz/tq?tqx=out:csv&sheet=%D0%A2%D0%BE%D0%B2%D0%B0%D1%80%D1%8B');
    assert.ok(calls[1].opts.signal instanceof AbortSignal, 'передан AbortSignal');
    const cache = JSON.parse(storage.getItem('catalog:sheet'));
    assert.equal(typeof cache.ts, 'number');
    assert.equal(cache.sheetId, 'ABC123');
    assert.equal(cache.products[0].name, 'Sheet A');
  });

  test('исключение внутри onUpdate — console.error, а не «таблица недоступна»', async () => {
    const { fetchImpl } = makeFetch(okCsv(SHEET_CSV));
    const errors = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      await loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl, storage: memoryStorage(), onUpdate: () => { throw new Error('render broke'); } });
      await tick();
    } finally {
      console.error = origError;
    }
    assert.equal(warnings.length, 0, 'сетевого warning нет');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('render broke'));
  });

  test('HTTP 500 → warning, onUpdate не вызывается, кэша нет', async () => {
    const { fetchImpl } = makeFetch({ ok: false, status: 500, text: async () => '' });
    const storage = memoryStorage();
    let updates = 0;
    const res = await loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl, storage, onUpdate: () => updates++ });
    await tick();
    assert.equal(res.source, 'json');
    assert.equal(updates, 0);
    assert.equal(storage.getItem('catalog:sheet'), null);
    assert.ok(warnings.some((w) => w.includes('HTTP 500')));
  });

  test('таймаут 6 с: реальный таймер отменяет запрос через AbortController → warning, onUpdate не вызывается', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let signal = null;
      // «Вечный» запрос, который завершается только по сигналу отмены
      const { fetchImpl } = makeFetch((opts) => new Promise((_, reject) => {
        signal = opts.signal;
        signal.addEventListener('abort', () => reject(signal.reason));
      }));
      let updates = 0;
      await loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl, storage: memoryStorage(), onUpdate: () => updates++ });
      assert.ok(signal instanceof AbortSignal);
      mock.timers.tick(5999);
      await new Promise((r) => setImmediate(r));
      assert.equal(signal.aborted, false, 'до 6 с запрос жив');
      assert.equal(warnings.length, 0);
      mock.timers.tick(1);
      await new Promise((r) => setImmediate(r));
      assert.equal(signal.aborted, true);
      assert.equal(updates, 0);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('таймаут 6000 мс'), warnings[0]);
    } finally {
      mock.timers.reset();
    }
  });

  test('успешный ответ снимает таймер: после загрузки отмены нет', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { fetchImpl, calls } = makeFetch(okCsv(SHEET_CSV));
      await new Promise((resolve) => {
        loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl, storage: memoryStorage(), onUpdate: resolve });
      });
      mock.timers.tick(10_000);
      assert.equal(calls[1].opts.signal.aborted, false);
    } finally {
      mock.timers.reset();
    }
  });

  test('200 + HTML (закрытая таблица → страница входа) → fallback: 0 товаров, warning', async () => {
    const html = '<!DOCTYPE html><html><head><title>Google Sheets</title></head><body>Sign in</body></html>';
    const { fetchImpl } = makeFetch(okCsv(html));
    const storage = memoryStorage();
    let updates = 0;
    const res = await loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl, storage, onUpdate: () => updates++ });
    await tick();
    assert.equal(res.source, 'json');
    assert.equal(updates, 0);
    assert.equal(storage.getItem('catalog:sheet'), null);
    assert.ok(warnings.some((w) => w.includes('таблица недоступна')));
  });

  test('пустой CSV / только заголовок → источник невалиден, остаёмся на JSON', async () => {
    for (const body of ['', 'id,Название\n', 'мусор,без,заголовков\n1,2,3']) {
      warnings = [];
      const { fetchImpl } = makeFetch(okCsv(body));
      const storage = memoryStorage();
      let updates = 0;
      await loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl, storage, onUpdate: () => updates++ });
      await tick();
      assert.equal(updates, 0, `тело «${body}»`);
      assert.equal(storage.getItem('catalog:sheet'), null);
      assert.ok(warnings.some((w) => w.includes('таблица недоступна')));
    }
  });

  const CACHED = [{ id: 9, name: 'Cached', category: 'goat', price: 300, available: true, photo: '', sort: 1 }];
  const cacheRecord = (ts, sheetId = 'X') => ({ 'catalog:sheet': JSON.stringify({ ts, sheetId, products: CACHED }) });
  const sheetDown = () => makeFetch({ ok: false, status: 503, text: async () => '' }).fetchImpl;

  test('свежий кэш листа + совпадающий sheetId → source sheet-cache (таблица недоступна)', async () => {
    const cfg = { ...CONFIG, sheetId: 'X' };
    const a = await loadCatalog({ config: cfg, fetchImpl: sheetDown(), storage: memoryStorage(cacheRecord(Date.now() - 1000)) });
    await tick();
    assert.equal(a.source, 'sheet-cache');
    assert.deepEqual(a.products.map((p) => p.name), ['Cached']);
    assert.equal(a.products[0].photo, 'images/9.jpg');
    assert.deepEqual(a.categories, CATEGORIES, 'категории всегда из products.json');
  });

  test('кэш + доступная таблица: сначала кэш, затем onUpdate с source sheet', async () => {
    const { fetchImpl } = makeFetch(okCsv(SHEET_CSV));
    const storage = memoryStorage(cacheRecord(Date.now() - 1000));
    const order = [];
    const done = new Promise((resolve) => {
      loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl, storage, onUpdate: (u) => { order.push(u.source); resolve(u); } })
        .then((first) => { order.push(first.source); });
    });
    const upd = await done;
    assert.deepEqual(order, ['sheet-cache', 'sheet']);
    assert.deepEqual(upd.products.map((p) => p.name), ['Sheet A']);
    assert.equal(JSON.parse(storage.getItem('catalog:sheet')).products[0].name, 'Sheet A', 'кэш обновлён');
  });

  test('просроченный, «из будущего», битый кэш или без storage → json', async () => {
    const cfg = { ...CONFIG, sheetId: 'X' };
    const cases = [
      memoryStorage(cacheRecord(Date.now() - 25 * 3600 * 1000)),
      memoryStorage(cacheRecord(Date.now() + 25 * 3600 * 1000)),
      memoryStorage({ 'catalog:sheet': '{oops' }),
      memoryStorage({ 'catalog:sheet': JSON.stringify({ ts: 'now', sheetId: 'X', products: CACHED }) }),
      undefined,
    ];
    for (const storage of cases) {
      const r = await loadCatalog({ config: cfg, fetchImpl: sheetDown(), storage });
      assert.equal(r.source, 'json');
    }
    await tick();
    const ok = await loadCatalog({ config: cfg, fetchImpl: sheetDown(), storage: memoryStorage(cacheRecord(Date.now() + 1000)) });
    assert.equal(ok.source, 'sheet-cache', 'часы чуть спешат — возраст по модулю');
  });

  test('кэш другой таблицы или кэш при пустом sheetId игнорируется, сеть не трогается', async () => {
    const other = await loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl: sheetDown(), storage: memoryStorage(cacheRecord(Date.now(), 'OLD')) });
    await tick();
    assert.equal(other.source, 'json');

    const { fetchImpl, calls } = makeFetch(null);
    const none = await loadCatalog({ config: { ...CONFIG, sheetId: '' }, fetchImpl, storage: memoryStorage(cacheRecord(Date.now(), 'X')) });
    assert.equal(none.source, 'json');
    assert.equal(calls.length, 1, 'только products.json');
    const legacy = await loadCatalog({ config: { ...CONFIG, sheetId: 'X' }, fetchImpl: sheetDown(), storage: memoryStorage({ 'catalog:sheet': JSON.stringify({ ts: Date.now(), products: CACHED }) }) });
    await tick();
    assert.equal(legacy.source, 'json', 'старый кэш без sheetId');
  });

  test('products.json недоступен → исключение', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    await assert.rejects(loadCatalog({ config: CONFIG, fetchImpl, storage: memoryStorage() }), /404/);
  });
});
