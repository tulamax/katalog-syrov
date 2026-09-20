import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGrams, parseGramsInput, formatMoney, formatGrams, buildOrderText, createCart,
} from '../../js/cart.js';
import { CONFIG } from '../../js/config.js';

const RULE = { step: CONFIG.weightStep, min: CONFIG.minWeight };

const PRODUCTS = [
  { id: 6, name: 'Landana 1000 дн', category: 'hard', description: '', price: 550, available: true, photo: 'images/6.jpg', sort: 6 },
  { id: 43, name: 'Сантагюр', category: 'blue', description: '', price: null, available: true, photo: 'images/43.jpg', sort: 43 },
  { id: 47, name: 'Gorgonzola Igor синяя', category: 'blue', description: '', price: 333, available: true, photo: 'images/47.jpg', sort: 47 },
  { id: 40, name: 'Дорблю Польша', category: 'blue', description: '', price: 400, available: false, photo: 'images/40.jpg', sort: 40 },
];

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const makeCart = (storage = memoryStorage(), products = PRODUCTS) => createCart({ storage, config: CONFIG, products });

describe('normalizeGrams', () => {
  test('правила ТЗ: 100.5 → 100, 130 → 150, 20 → min, 0/пусто → 0', () => {
    assert.equal(normalizeGrams(100.5, RULE), 100);
    assert.equal(normalizeGrams(130, RULE), 150);
    assert.equal(normalizeGrams(20, RULE), 50);
    assert.equal(normalizeGrams(0, RULE), 0);
    assert.equal(normalizeGrams('', RULE), 0);
    assert.equal(normalizeGrams('  ', RULE), 0);
  });

  test('краевые случаи: строки, отрицательные, нечисла, кратные step', () => {
    assert.equal(normalizeGrams('175', RULE), 200);
    assert.equal(normalizeGrams('124', RULE), 100);
    assert.equal(normalizeGrams('125', RULE), 150);
    assert.equal(normalizeGrams('1 000', RULE), 1000, 'пробелы убираются до Number');
    assert.equal(normalizeGrams('1\u00a0000', RULE), 1000);
    assert.equal(normalizeGrams(' 2 5 0 ', RULE), 250);
    assert.equal(normalizeGrams('1e', RULE), 0);
    assert.equal(normalizeGrams('-', RULE), 0);
    assert.equal(normalizeGrams(250, RULE), 250);
    assert.equal(normalizeGrams(50, RULE), 50);
    assert.equal(normalizeGrams(-5, RULE), 0);
    assert.equal(normalizeGrams('abc', RULE), 0);
    assert.equal(normalizeGrams(null, RULE), 0);
    assert.equal(normalizeGrams(undefined, RULE), 0);
    assert.equal(normalizeGrams(NaN, RULE), 0);
    assert.equal(normalizeGrams(Infinity, RULE), 0);
  });
});

describe('parseGramsInput', () => {
  test('число из поля; пусто или нечисло → null (корзина не меняется)', () => {
    const cases = [
      ['200', 200], [' 130 ', 130], ['1 000', 1000], ['0', 0], ['-5', -5], ['100.5', 100.5], ['100,5', 100.5],
      ['', null], ['   ', null], ['1e', null], ['1e3', null], ['-', null], ['abc', null], ['12a', null],
      [null, null], [undefined, null], [250, 250],
    ];
    const res = cases.map(([v]) => parseGramsInput(v));
    assert.equal(res.length, cases.length);
    res.forEach((r, i) => assert.equal(r, cases[i][1], `ввод «${cases[i][0]}»`));
  });
});

describe('форматирование', () => {
  test('formatMoney: пробел-разделитель тысяч, округление до рубля', () => {
    assert.equal(formatMoney(0), '0');
    assert.equal(formatMoney(999), '999');
    assert.equal(formatMoney(1100), '1 100');
    assert.equal(formatMoney(15000), '15 000');
    assert.equal(formatMoney(1234567), '1 234 567');
    assert.equal(formatMoney(1249.5), '1 250');
    assert.equal(formatMoney(NaN), '0');
  });

  test('formatGrams', () => {
    assert.equal(formatGrams(200), '200 г');
    assert.equal(formatGrams(1500), '1 500 г');
  });
});

describe('сумма и итоги', () => {
  test('сумма позиции = price * grams / 100 с округлением до рубля; null для «по запросу»', () => {
    const cart = makeCart();
    cart.setGrams(6, 200);   // 550 * 2 = 1100
    cart.setGrams(47, 150);  // 333 * 1.5 = 499.5 → 500
    cart.setGrams(43, 100);  // цена по запросу
    const lines = cart.getLines();
    assert.deepEqual(lines.map((l) => [l.product.id, l.grams, l.sum]), [[6, 200, 1100], [47, 150, 500], [43, 100, null]]);
    assert.deepEqual(cart.getTotals(), { sum: 1600, grams: 450, count: 3, hasOnRequest: true });
  });

  test('пустая корзина: нули', () => {
    assert.deepEqual(makeCart().getTotals(), { sum: 0, grams: 0, count: 0, hasOnRequest: false });
  });
});

describe('buildOrderText', () => {
  const lines = [
    { product: PRODUCTS[0], grams: 200, sum: 1100 },
    { product: PRODUCTS[1], grams: 100, sum: null },
  ];

  test('точное совпадение с примером из ТЗ §4', () => {
    const text = buildOrderText({
      lines,
      customer: { name: 'Анна', phone: '+7 916 123-45-67', address: 'ул. Ленина, 1', comment: 'позвонить заранее' },
      totals: { sum: 1100, grams: 300, count: 2, hasOnRequest: true },
      config: CONFIG,
    });
    assert.equal(text, [
      'Здравствуйте! Хочу заказать:',
      '',
      '• Landana 1000 дн — 200 г — 1 100 ₽',
      '• Сантагюр — 100 г — цена по запросу',
      '',
      'Итого: 1 100 ₽ (+ позиции по запросу)',
      'Всего: 300 г',
      '',
      'Имя: Анна',
      'Телефон: +7 916 123-45-67',
      'Адрес: ул. Ленина, 1',
      'Комментарий: позвонить заранее',
      '',
      'Подтвердите, пожалуйста, наличие, цену и способ доставки.',
    ].join('\n'));
  });

  test('пустые поля покупателя не выводятся; блок отсутствует целиком, если все пусты', () => {
    const partial = buildOrderText({
      lines: [lines[0]], customer: { name: '  ', phone: '+7 900', address: '', comment: '' },
      totals: { sum: 1100, grams: 200, count: 1, hasOnRequest: false }, config: CONFIG,
    });
    assert.equal(partial, [
      'Здравствуйте! Хочу заказать:', '',
      '• Landana 1000 дн — 200 г — 1 100 ₽', '',
      'Итого: 1 100 ₽', 'Всего: 200 г', '',
      'Телефон: +7 900', '',
      'Подтвердите, пожалуйста, наличие, цену и способ доставки.',
    ].join('\n'));

    const none = buildOrderText({
      lines: [lines[0]], customer: { name: '', phone: '', address: '', comment: '' },
      totals: { sum: 1100, grams: 200, count: 1, hasOnRequest: false }, config: CONFIG,
    });
    assert.ok(!none.includes('Имя:') && !none.includes('Телефон:'));
    assert.ok(none.endsWith('Всего: 200 г\n\nПодтвердите, пожалуйста, наличие, цену и способ доставки.'));
  });

  test('строка «Итого»: все по запросу / есть суммы / суммы + по запросу', () => {
    const onlyRequest = buildOrderText({ lines: [lines[1]], customer: {}, config: CONFIG });
    assert.ok(onlyRequest.includes('\nИтого: цена по запросу\nВсего: 100 г\n'), onlyRequest);
    assert.ok(!onlyRequest.includes('0 ₽') && !onlyRequest.includes('(+ позиции по запросу)'));

    const priced = buildOrderText({ lines: [lines[0]], customer: {}, config: CONFIG });
    assert.ok(priced.includes('\nИтого: 1 100 ₽\nВсего: 200 г\n'), priced);

    const mixed = buildOrderText({ lines, customer: {}, config: CONFIG });
    assert.ok(mixed.includes('\nИтого: 1 100 ₽ (+ позиции по запросу)\nВсего: 300 г\n'), mixed);
  });

  test('тексты берутся из config, totals при отсутствии считаются из lines', () => {
    const config = { ...CONFIG, currency: 'руб.', orderGreeting: 'Привет!', orderFooter: 'Пока.' };
    const text = buildOrderText({ lines: [lines[0]], config });
    assert.equal(text, 'Привет!\n\n• Landana 1000 дн — 200 г — 1 100 руб.\n\nИтого: 1 100 руб.\nВсего: 200 г\n\nПока.');
  });
});

describe('createCart', () => {
  test('setGrams / remove / clear, порядок добавления, персист {items: [[id, grams]], customer}', () => {
    const storage = memoryStorage();
    const cart = makeCart(storage);
    cart.setGrams(43, 100);
    cart.setGrams(6, 130);     // → 150
    assert.equal(cart.getGrams(6), 150);
    assert.deepEqual([...cart.items], [[43, 100], [6, 150]]);
    cart.setGrams(43, '175');  // → 200
    assert.equal(cart.getGrams(43), 200);
    assert.deepEqual(cart.getLines().map((l) => l.product.id), [43, 6]);

    const saved = JSON.parse(storage.getItem('cart:v1'));
    assert.deepEqual(saved.items, [[43, 200], [6, 150]]);

    cart.remove(43);
    assert.equal(cart.getGrams(43), 0);
    cart.setCustomer({ name: 'Анна' });
    cart.clear();
    assert.equal(cart.items.size, 0);
    assert.equal(cart.customer.name, '');
    assert.deepEqual(JSON.parse(storage.getItem('cart:v1')), {
      items: [], customer: { name: '', phone: '', address: '', comment: '' },
    });
  });

  test('setGrams 0 / пусто удаляет позицию; меньше min ставит min; строка «1 000»', () => {
    const cart = makeCart();
    cart.setGrams(6, 20);
    assert.equal(cart.getGrams(6), 50);
    cart.setGrams(6, 0);
    assert.equal(cart.items.has(6), false);
    cart.setGrams(6, 100);
    cart.setGrams(6, '');
    assert.equal(cart.items.size, 0);
    cart.setGrams(6, '1 000');
    assert.equal(cart.getGrams(6), 1000);
  });

  test('setGrams игнорирует недоступный и несуществующий товар; без уведомления', () => {
    const cart = makeCart();
    let calls = 0;
    cart.subscribe(() => calls++);
    cart.setGrams(40, 100);   // available=false
    cart.setGrams(999, 100);  // нет в каталоге
    cart.setGrams('40', '200');
    assert.equal(cart.items.size, 0);
    assert.equal(cart.getTotals().count, 0);
    assert.equal(calls, 0);
    assert.equal('add' in cart, false, 'метода add больше нет');
  });

  test('getLines не отдаёт позиции, ставшие недоступными после setProducts без прочистки', () => {
    // Корзина создана без каталога: позиции из storage лежат «как есть»
    const cart = createCart({ storage: memoryStorage({ 'cart:v1': JSON.stringify({ items: [[6, 200], [40, 100]] }) }), config: CONFIG });
    assert.equal(cart.items.size, 2);
    assert.deepEqual(cart.getLines(), []);
    cart.setProducts(PRODUCTS);
    assert.deepEqual(cart.getLines().map((l) => l.product.id), [6]);
    assert.equal(cart.getTotals().count, 1);
  });

  test('clearItems очищает позиции, оставляет покупателя, уведомляет; clear чистит всё', () => {
    const storage = memoryStorage();
    const cart = makeCart(storage);
    cart.setGrams(6, 200);
    cart.setCustomer({ name: 'Анна', phone: '+7 900' });
    let calls = 0;
    cart.subscribe(() => calls++);
    cart.clearItems();
    assert.equal(calls, 1);
    assert.equal(cart.items.size, 0);
    assert.deepEqual(cart.customer, { name: 'Анна', phone: '+7 900', address: '', comment: '' });
    assert.deepEqual(JSON.parse(storage.getItem('cart:v1')), {
      items: [], customer: { name: 'Анна', phone: '+7 900', address: '', comment: '' },
    });
    cart.setGrams(6, 100);
    cart.clear();
    assert.equal(cart.items.size, 0);
    assert.equal(cart.customer.name, '');
    assert.equal(calls, 3);
  });

  test('items и customer — копии: изменение снаружи не влияет на корзину', () => {
    const cart = makeCart();
    cart.setGrams(6, 100);
    cart.items.set(47, 100);
    cart.customer.name = 'взлом';
    assert.equal(cart.items.size, 1);
    assert.equal(cart.customer.name, '');
  });

  test('setCustomer: частичное обновление, только строки', () => {
    const cart = makeCart();
    cart.setCustomer({ name: 'Анна', phone: 123, extra: 'x' });
    cart.setCustomer({ address: 'ул. Ленина, 1' });
    assert.deepEqual(cart.customer, { name: 'Анна', phone: '', address: 'ул. Ленина, 1', comment: '' });
  });

  test('восстановление из storage при создании; битый JSON → пустая корзина', () => {
    const storage = memoryStorage();
    const a = makeCart(storage);
    a.setGrams(6, 200);
    a.setGrams(43, 100);
    a.setCustomer({ phone: '+7 900' });

    const b = makeCart(storage);
    assert.deepEqual([...b.items], [[6, 200], [43, 100]]);
    assert.equal(b.customer.phone, '+7 900');

    const c = makeCart(memoryStorage({ 'cart:v1': '{не json' }));
    assert.equal(c.items.size, 0);
    const d = makeCart(memoryStorage({ 'cart:v1': JSON.stringify({ items: 'oops', customer: 5 }) }));
    assert.equal(d.items.size, 0);
    assert.equal(d.customer.name, '');
  });

  test('readRecord: items только массив пар или объект; строка, число, null, пары-непары → пусто', () => {
    const records = [
      { items: 'oops' }, { items: 42 }, { items: null }, { items: true }, { items: '[[6,200]]' },
      { items: [6, 200] }, { items: [['x', 200], [6, 'много'], [0, 100], [-1, 100]] }, 'строка', [[6, 200]], 7,
    ];
    for (const rec of records) {
      const cart = makeCart(memoryStorage({ 'cart:v1': JSON.stringify(rec) }));
      assert.equal(cart.items.size, 0, JSON.stringify(rec));
    }
    const ok = makeCart(memoryStorage({ 'cart:v1': JSON.stringify({ items: [['6', '200'], [43, 100]] }) }));
    assert.deepEqual([...ok.items], [[6, 200], [43, 100]]);
  });

  test('при восстановлении удаляются пропавшие и недоступные позиции', () => {
    const storage = memoryStorage({
      'cart:v1': JSON.stringify({ items: [[6, 200], [40, 100], [999, 100], [43, 100]], customer: { name: 'Анна' } }),
    });
    const cart = makeCart(storage);
    assert.deepEqual([...cart.items], [[6, 200], [43, 100]]);
    assert.equal(cart.customer.name, 'Анна');
  });

  test('старый формат items как объект {id: grams} тоже читается', () => {
    const cart = makeCart(memoryStorage({ 'cart:v1': JSON.stringify({ items: { 6: 200, 43: 100 } }) }));
    assert.deepEqual([...cart.items], [[6, 200], [43, 100]]);
  });

  test('корзина без каталога хранит позиции до setProducts, потом чистится', () => {
    const storage = memoryStorage({ 'cart:v1': JSON.stringify({ items: [[6, 200], [40, 100]] }) });
    const cart = createCart({ storage, config: CONFIG });
    assert.equal(cart.items.size, 2, 'до загрузки каталога ничего не выкидываем');
    assert.equal(cart.getLines().length, 0);
    let calls = 0;
    cart.subscribe(() => calls++);
    cart.setProducts(PRODUCTS);
    assert.deepEqual([...cart.items], [[6, 200]]);
    assert.equal(cart.getLines().length, 1);
    assert.equal(calls, 1);
  });

  test('storage undefined (приватный режим) и storage с исключениями — работа в памяти', () => {
    const cart = createCart({ storage: undefined, config: CONFIG, products: PRODUCTS });
    cart.setGrams(6, 100);
    assert.equal(cart.getGrams(6), 100);
    cart.saveLastOrder();
    assert.equal(cart.hasLastOrder(), false);
    assert.equal(cart.restoreLastOrder(), false);

    const throwing = { getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); }, removeItem() {} };
    const cart2 = createCart({ storage: throwing, config: CONFIG, products: PRODUCTS });
    cart2.setGrams(6, 100);
    assert.equal(cart2.getTotals().sum, 550);
    assert.equal(cart2.hasLastOrder(), false);
  });

  test('subscribe: вызов после каждого изменения, unsubscribe', () => {
    const cart = makeCart();
    const seen = [];
    const off = cart.subscribe((c) => seen.push(c.getTotals().count));
    cart.setGrams(6, 100);
    cart.setCustomer({ name: 'A' });
    cart.remove(999);        // ничего не изменилось — без уведомления
    cart.remove(6);
    off();
    cart.setGrams(6, 100);
    assert.deepEqual(seen, [1, 1, 0]);
  });

  test('canSend: нужны позиции и имя или телефон (после trim)', () => {
    const cart = makeCart();
    assert.equal(cart.canSend(), false);
    cart.setGrams(6, 100);
    assert.equal(cart.canSend(), false);
    cart.setCustomer({ name: '   ' });
    assert.equal(cart.canSend(), false);
    cart.setCustomer({ phone: ' +7 900 ' });
    assert.equal(cart.canSend(), true);
    cart.setCustomer({ phone: '', name: 'Анна' });
    assert.equal(cart.canSend(), true);
    cart.clear();
    assert.equal(cart.canSend(), false);
  });

  test('getOrderText совпадает с buildOrderText по текущему состоянию', () => {
    const cart = makeCart();
    cart.setGrams(6, 200);
    cart.setGrams(43, 100);
    cart.setCustomer({ name: 'Анна', phone: '+7 916 123-45-67', address: 'ул. Ленина, 1', comment: 'позвонить заранее' });
    assert.equal(cart.getOrderText(), buildOrderText({
      lines: cart.getLines(), customer: cart.customer, totals: cart.getTotals(), config: CONFIG,
    }));
    assert.ok(cart.getOrderText().includes('• Landana 1000 дн — 200 г — 1 100 ₽\n• Сантагюр — 100 г — цена по запросу'));
  });

  test('последний заказ: save / has / restore только доступных позиций и покупателя', () => {
    const storage = memoryStorage();
    const cart = makeCart(storage);
    assert.equal(cart.hasLastOrder(), false);
    cart.setGrams(6, 200);
    cart.setGrams(47, 100);
    cart.setCustomer({ name: 'Анна', comment: 'к 18:00' });
    cart.saveLastOrder();
    assert.equal(cart.hasLastOrder(), true);
    assert.ok(storage.getItem('lastOrder:v1'));

    cart.clear();
    assert.equal(cart.items.size, 0);

    // Один из товаров закончился к моменту повтора
    cart.setProducts(PRODUCTS.map((p) => (p.id === 47 ? { ...p, available: false } : p)));
    let notified = 0;
    cart.subscribe(() => notified++);
    assert.equal(cart.restoreLastOrder(), true);
    assert.deepEqual([...cart.items], [[6, 200]]);
    assert.deepEqual(cart.customer, { name: 'Анна', phone: '', address: '', comment: 'к 18:00' });
    assert.equal(notified, 1);
    assert.deepEqual(JSON.parse(storage.getItem('cart:v1')).items, [[6, 200]], 'восстановленная корзина сохранена');
  });

  test('последний заказ: пустой или битый → hasLastOrder false, restore false', () => {
    const a = makeCart(memoryStorage({ 'lastOrder:v1': JSON.stringify({ items: [], customer: {} }) }));
    assert.equal(a.hasLastOrder(), false);
    assert.equal(a.restoreLastOrder(), false);
    const b = makeCart(memoryStorage({ 'lastOrder:v1': '[broken' }));
    assert.equal(b.hasLastOrder(), false);
  });

  test('hasLastOrder: true только при доступной позиции; пересчёт в конструкторе, setProducts, saveLastOrder', () => {
    const storage = memoryStorage({
      'lastOrder:v1': JSON.stringify({ items: [[40, 100], [999, 100]], customer: { name: 'Анна' } }),
    });
    const cart = makeCart(storage);
    assert.equal(cart.hasLastOrder(), false, 'все позиции недоступны/пропали');
    assert.equal(cart.restoreLastOrder(), false, 'восстанавливать нечего');
    assert.equal(cart.items.size, 0);
    assert.equal(cart.customer.name, '', 'покупатель не тронут');

    // Товар 40 снова в наличии → прошлый заказ пригоден
    cart.setProducts(PRODUCTS.map((p) => (p.id === 40 ? { ...p, available: true } : p)));
    assert.equal(cart.hasLastOrder(), true);
    assert.equal(cart.restoreLastOrder(), true);
    assert.deepEqual([...cart.items], [[40, 100]]);

    // Прошлый заказ из одних недоступных позиций → снова false
    cart.setProducts(PRODUCTS);
    assert.equal(cart.hasLastOrder(), false);

    // Корзина без каталога: прошлый заказ есть, но пока ничего не доступно
    const blind = createCart({ storage: memoryStorage({ 'lastOrder:v1': JSON.stringify({ items: [[6, 200]] }) }), config: CONFIG });
    assert.equal(blind.hasLastOrder(), false);
    blind.setProducts(PRODUCTS);
    assert.equal(blind.hasLastOrder(), true);
  });

  test('hasLastOrder кэшируется: storage не читается на каждый notify', () => {
    let reads = 0;
    const map = new Map();
    const storage = {
      getItem: (k) => { if (k === 'lastOrder:v1') reads++; return map.has(k) ? map.get(k) : null; },
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
    const cart = createCart({ storage, config: CONFIG, products: PRODUCTS });
    const after = reads;
    cart.setGrams(6, 100);
    cart.setCustomer({ name: 'A' });
    cart.hasLastOrder();
    cart.hasLastOrder();
    cart.remove(6);
    assert.equal(reads, after, 'без saveLastOrder/setProducts чтений нет');
    cart.setGrams(6, 100);
    cart.saveLastOrder();
    assert.equal(cart.hasLastOrder(), true);
    assert.equal(reads, after + 1);
  });
});
