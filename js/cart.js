// Корзина: позиции id→граммы, данные покупателя, localStorage, сумма,
// текст заказа и «последний заказ» (SPEC §4).
import { CONFIG } from './config.js';

const CART_KEY = 'cart:v1';
const LAST_ORDER_KEY = 'lastOrder:v1';
const EMPTY_CUSTOMER = Object.freeze({ name: '', phone: '', address: '', comment: '' });

// Строка из поля ввода без пробелов (в т.ч. «1 000» → «1000»), запятая → точка
const cleanNumeric = (value) => String(value ?? '').replace(/\s/g, '').replace(',', '.');

/**
 * Граммы из ввода: нечисло/≤0 → 0 («удалить»), меньше min → min,
 * иначе — ближайшее кратное step (130 → 150, 100.5 → 100). '1 000' → 1000.
 */
export function normalizeGrams(value, { step, min }) {
  const n = typeof value === 'string' ? Number(cleanNumeric(value)) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < min) return min;
  const rounded = step > 0 ? Math.round(n / step) * step : Math.round(n);
  return Math.max(rounded, min);
}

/**
 * Значение поля граммов для UI: число или null, если строка пуста или не число
 * ('1e', '-', '  '). По null UI корзину не трогает и возвращает поле к текущему значению.
 * @returns {number|null}
 */
export function parseGramsInput(value) {
  const s = cleanNumeric(value);
  if (!s || !/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** '1100' → '1 100'; тысячи разделяются пробелом, копейки округляются. */
export function formatMoney(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '0';
  const digits = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return v < 0 ? `-${digits}` : digits;
}

export function formatGrams(g) {
  return `${formatMoney(g)} г`;
}

// Сумма позиции: price * grams / 100 до рубля; null — «цена по запросу»
function lineSum(product, grams) {
  return product.price === null ? null : Math.round(product.price * grams / 100);
}

function totalsOf(lines) {
  const t = { sum: 0, grams: 0, count: lines.length, hasOnRequest: false };
  for (const l of lines) {
    t.grams += l.grams;
    if (l.sum === null) t.hasOnRequest = true; else t.sum += l.sum;
  }
  return t;
}

/**
 * Текст заказа в фиксированном формате SPEC §4.
 * @param {{lines: {product: object, grams: number, sum: number|null}[], customer?: object, totals?: object, config?: object}} p
 */
export function buildOrderText({ lines = [], customer = EMPTY_CUSTOMER, totals, config = CONFIG }) {
  const t = totals || totalsOf(lines);
  const cur = config.currency;
  const blocks = [config.orderGreeting];

  blocks.push(lines.map((l) =>
    `• ${l.product.name} — ${formatGrams(l.grams)} — ${l.sum === null ? 'цена по запросу' : `${formatMoney(l.sum)} ${cur}`}`,
  ).join('\n'));

  const total = (t.sum === 0 && t.hasOnRequest)
    ? 'Итого: цена по запросу'
    : `Итого: ${formatMoney(t.sum)} ${cur}${t.hasOnRequest ? ' (+ позиции по запросу)' : ''}`;
  blocks.push(`${total}\nВсего: ${formatGrams(t.grams)}`);

  const who = [['name', 'Имя'], ['phone', 'Телефон'], ['address', 'Адрес'], ['comment', 'Комментарий']]
    .map(([key, label]) => [label, String(customer[key] ?? '').trim()])
    .filter(([, v]) => v)
    .map(([label, v]) => `${label}: ${v}`);
  if (who.length) blocks.push(who.join('\n'));

  blocks.push(config.orderFooter);
  return blocks.join('\n\n');
}

// Безопасный разбор записи из storage: {items: [[id, grams]] | {id: grams}, customer}
function readRecord(storage, key) {
  try {
    const raw = storage && storage.getItem(key);
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object') return null;
    // items — массив пар [[id, grams]] или объект {id: grams} (старый формат); иное → пусто
    let pairs = [];
    if (Array.isArray(data.items)) pairs = data.items;
    else if (data.items && typeof data.items === 'object') pairs = Object.entries(data.items);
    const items = [];
    for (const pair of pairs) {
      if (!Array.isArray(pair)) continue;
      const id = Number(pair[0]);
      const grams = Number(pair[1]);
      if (Number.isInteger(id) && id > 0 && Number.isFinite(grams) && grams > 0) items.push([id, grams]);
    }
    const c = data.customer && typeof data.customer === 'object' ? data.customer : {};
    const customer = {};
    for (const k of Object.keys(EMPTY_CUSTOMER)) customer[k] = typeof c[k] === 'string' ? c[k] : '';
    return { items, customer };
  } catch {
    return null;
  }
}

function writeRecord(storage, key, record) {
  try {
    if (storage) storage.setItem(key, JSON.stringify(record));
  } catch {
    // приватный режим / переполнение: работаем в памяти
  }
}

/**
 * Создаёт корзину. storage может быть undefined (приватный режим) — тогда только память.
 * @param {{storage?: Storage, config?: object, products?: object[]}} opts
 */
export function createCart({ storage = globalThis.localStorage, config = CONFIG, products = [] } = {}) {
  const gramsRule = { step: config.weightStep, min: config.minWeight };
  let byId = new Map();
  let items = new Map();          // id → grams, порядок добавления
  let customer = { ...EMPTY_CUSTOMER };
  let lastOrderReady = false;      // есть прошлый заказ хотя бы с одной доступной позицией
  const listeners = new Set();

  const isOrderable = (id) => {
    const p = byId.get(id);
    return Boolean(p && p.available);
  };

  // Оставляет только позиции, которые есть в каталоге и доступны
  const prune = () => {
    for (const id of [...items.keys()]) if (!isOrderable(id)) items.delete(id);
  };

  const snapshot = () => ({ items: [...items.entries()], customer: { ...customer } });

  const notify = () => {
    writeRecord(storage, CART_KEY, snapshot());
    for (const fn of listeners) {
      try { fn(cart); } catch (e) { console.error('[cart] ошибка подписчика', e); }
    }
  };

  const setProductsInternal = (list) => {
    byId = new Map((Array.isArray(list) ? list : []).map((p) => [p.id, p]));
  };

  // Кэш hasLastOrder: localStorage не читаем на каждый notify — только когда
  // меняется сам заказ (saveLastOrder) или каталог (setProducts)
  const refreshLastOrder = () => {
    const rec = readRecord(storage, LAST_ORDER_KEY);
    lastOrderReady = Boolean(rec && rec.items.some(([id]) => isOrderable(id)));
  };

  const applyRecord = (rec, { onlyOrderable }) => {
    items = new Map();
    for (const [id, grams] of rec.items) {
      if (onlyOrderable && !isOrderable(id)) continue;
      const g = normalizeGrams(grams, gramsRule);
      if (g > 0) items.set(id, g);
    }
    customer = { ...rec.customer };
  };

  // Только доступные позиции: недоступные в сумму, текст и отправку не попадают
  const getLines = () => {
    const lines = [];
    for (const [id, grams] of items) {
      const product = byId.get(id);
      if (product && product.available) lines.push({ product, grams, sum: lineSum(product, grams) });
    }
    return lines;
  };

  const cart = {
    get items() { return new Map(items); },
    get customer() { return { ...customer }; },

    setProducts(list) {
      setProductsInternal(list);
      prune();
      refreshLastOrder();
      notify();
    },

    getGrams(id) { return items.get(Number(id)) || 0; },

    // 0/пусто → удалить; товар не из каталога или available=false — игнорируется
    setGrams(id, grams) {
      const key = Number(id);
      const g = normalizeGrams(grams, gramsRule);
      if (g === 0) { cart.remove(key); return; }
      if (!isOrderable(key)) return;
      items.set(key, g);
      notify();
    },

    remove(id) {
      if (items.delete(Number(id))) notify();
    },

    // Только позиции; данные покупателя остаются (кнопка «Очистить»)
    clearItems() {
      items = new Map();
      notify();
    },

    // Всё: позиции и покупатель
    clear() {
      items = new Map();
      customer = { ...EMPTY_CUSTOMER };
      notify();
    },

    setCustomer(patch) {
      for (const k of Object.keys(EMPTY_CUSTOMER)) {
        if (patch && typeof patch[k] === 'string') customer[k] = patch[k];
      }
      notify();
    },

    getLines,
    getTotals() { return totalsOf(getLines()); },

    getOrderText() {
      const lines = getLines();
      return buildOrderText({ lines, customer, totals: totalsOf(lines), config });
    },

    canSend() {
      return getLines().length > 0 && Boolean(customer.name.trim() || customer.phone.trim());
    },

    saveLastOrder() {
      writeRecord(storage, LAST_ORDER_KEY, snapshot());
      refreshLastOrder();
    },

    hasLastOrder() { return lastOrderReady; },

    // false — восстанавливать нечего (нет записи или все позиции недоступны)
    restoreLastOrder() {
      const rec = readRecord(storage, LAST_ORDER_KEY);
      if (!rec || !rec.items.some(([id]) => isOrderable(id))) return false;
      applyRecord(rec, { onlyOrderable: true });
      notify();
      return true;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  // Восстановление при открытии; чистим по каталогу только если он уже известен
  setProductsInternal(products);
  const saved = readRecord(storage, CART_KEY);
  if (saved) applyRecord(saved, { onlyOrderable: byId.size > 0 });
  refreshLastOrder();
  return cart;
}
