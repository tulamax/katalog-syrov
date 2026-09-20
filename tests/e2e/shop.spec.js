// E2E-сценарии SPEC §7 и §10. Запуск: npm run e2e (или npx playwright test).
// Синтаксис import работает и в CJS-, и в ESM-пакете: Playwright транслирует тест-файлы сам.
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const TEST_WA = '79990000000';
const TEST_TG = 'cheese_test';
const TEST_MAX = 'https://max.ru/cheese_test_max';
const ITEM = 6;       // Landana 1000 дн
const ITEM2 = 43;     // Сантагюр
const TEST_PRICE = 550; // цена, которую подставляем товару ITEM в сценарии 3

// Каждый тест: Google-таблица заблокирована; собираем console.error и необработанные исключения,
// в конце их не должно быть (сценарий 9). Опция consoleIgnore — регэкспы сообщений, которые тест
// вызывает намеренно (например, подменённое фото).
const test = base.extend({
  consoleIgnore: [[], { option: true }],
  errors: [async ({ page, consoleIgnore }, use) => {
    await page.route('**/docs.google.com/**', (route) => route.abort());
    const errors = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // Не ошибки нашего кода: сетевой лог браузера о запросе, который тест сам заблокировал,
      // и WebKit о неизвестном ему ключе viewport interactive-widget (он для Chrome).
      const where = (m.location() && m.location().url) || '';
      const text = where + ' ' + m.text();
      if (/docs\.google\.com/.test(text)) return;
      if (/Viewport argument key "interactive-widget"/.test(m.text())) return;
      if (consoleIgnore.some((re) => re.test(text))) return;
      errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await use(errors);
    expect(errors, 'консоль без ошибок уровня error').toEqual([]);
  }, { auto: true }],
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rootFile = (rel) => path.join(REPO_ROOT, rel);

let data;
test.beforeAll(() => {
  data = JSON.parse(fs.readFileSync(rootFile('data/products.json'), 'utf8'));
});

const isPhone = (page) => page.viewportSize().width < 900;

// Подменяем CONFIG (контакты, id таблицы) через перехват модуля — модульный импорт из addInitScript не переопределить.
async function useTestConfig(page, { sheetId } = {}) {
  const src = fs.readFileSync(rootFile('js/config.js'), 'utf8');
  let patched = src
    .replace(/whatsapp:\s*(['"`])[^'"`]*\1/, `whatsapp: '${TEST_WA}'`)
    .replace(/telegram:\s*(['"`])[^'"`]*\1/, `telegram: '${TEST_TG}'`)
    .replace(/max:\s*(['"`])[^'"`]*\1/, `max: '${TEST_MAX}'`);
  expect(patched, 'в js/config.js найдены поля whatsapp/telegram').not.toBe(src);
  if (sheetId !== undefined) {
    const withSheet = patched.replace(/sheetId:\s*(['"`])[^'"`]*\1/, `sheetId: '${sheetId}'`);
    expect(withSheet, 'в js/config.js найдено поле sheetId').not.toBe(patched);
    patched = withSheet;
  }
  await page.route('**/js/config.js', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: patched,
  }));
}

// Копия products.json, где у товара ITEM есть цена (в исходных данных все «по запросу»).
async function usePricedCatalog(page) {
  const copy = JSON.parse(JSON.stringify(data));
  copy.products.find((p) => p.id === ITEM).price = TEST_PRICE;
  await page.route('**/data/products.json', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(copy),
  }));
}

async function openShop(page) {
  await page.goto('/');
  await expect(page.locator('#grid .card')).toHaveCount(data.products.length);
}

const card = (page, id) => page.locator(`#grid .card[data-id="${id}"]`);
const cartLine = (page, id) => page.locator(`#cart-items li[data-id="${id}"]`);
const details = (page) => page.locator('#cart-details');

// На телефоне корзина свёрнута в нижнюю полосу — раскрываем перед работой с ней.
async function openCart(page) {
  if (!(await details(page).evaluate((d) => d.open))) await page.locator('.cart-head').click();
  await expect(page.locator('#order-text')).toBeVisible();
}

// Свернуть корзину на телефоне, чтобы она не перекрывала карточки (на десктопе — колонка, ничего не делаем).
async function closeCart(page) {
  if (isPhone(page) && (await details(page).evaluate((d) => d.open))) await page.locator('.cart-head').click();
}

async function setGrams(input, value) {
  await input.fill(String(value));
  await input.press('Enter');
}

const orderTextOf = async (link) => decodeURIComponent((await link.getAttribute('href')).split('?text=')[1]);

test('1. каталог рендерится: все карточки, фото загружены', async ({ page }) => {
  await openShop(page);
  await expect(page.locator('#grid .card img.photo')).toHaveCount(data.products.length);
  for (let i = 0; i < 4; i++) {
    const img = page.locator('#grid .card img.photo').nth(i);
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth), `фото №${i + 1} загружено`)
      .toBeGreaterThan(0);
  }
  await expect(page.locator('#categories .cat-btn[data-cat]')).toHaveCount(Object.keys(data.categories).length + 1);
  await expect(page.locator('#cart-count')).toHaveText('0 позиций');
  await expect(page.locator('#lightbox')).toBeHidden();
  // Раскладка: на телефоне корзина свёрнута, на десктопе раскрыта; в разметке <details> без open.
  await expect(details(page)).toHaveJSProperty('open', !isPhone(page));
});

test('2. поиск и фильтр по категории', async ({ page }) => {
  await openShop(page);
  const q = 'горгонзола';
  const expected = data.products.filter((p) => (p.name + ' ' + p.description).toLowerCase().includes(q));
  await page.locator('#search').fill('ГоргонЗола');
  await expect(page.locator('#grid .card:visible')).toHaveCount(expected.length);
  for (const p of expected) await expect(card(page, p.id)).toBeVisible();

  await page.locator('#search').fill('такого-сыра-нет');
  await expect(page.locator('#grid .card:visible')).toHaveCount(0);
  await expect(page.locator('#grid')).toContainText('Ничего не найдено');

  await page.locator('#search').fill('');
  await page.locator('#categories .cat-btn[data-cat="blue"]').click();
  const blue = data.products.filter((p) => p.category === 'blue');
  await expect(page.locator('#grid .card:visible')).toHaveCount(blue.length);
  await expect(page.locator('#categories .cat-btn[data-cat="blue"]')).toHaveClass(/active/);
  await page.locator('#categories .cat-btn[data-cat="all"]').click();
  await expect(page.locator('#grid .card:visible')).toHaveCount(data.products.length);
});

test('3. пресет, сумма, «+», ручной ввод с округлением, удаление нулём', async ({ page }) => {
  await useTestConfig(page);
  await usePricedCatalog(page);
  await openShop(page);
  const c = card(page, ITEM);
  const product = data.products.find((p) => p.id === ITEM);
  await expect(c.locator('.price')).toHaveText(`${TEST_PRICE} ₽ / 100 г`);

  await c.locator('.preset[data-grams="200"]').click();
  await expect(c.locator('input[data-qty]')).toHaveValue('200');
  await expect(c.locator('.add-btn')).toHaveText('✓ В корзине · 200 г');
  await expect(c.locator('.preset[data-grams="200"]')).toHaveClass(/active/);
  await expect(cartLine(page, ITEM)).toHaveCount(1);
  await expect(cartLine(page, ITEM).locator('.name')).toHaveText(product.name);
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('200');
  await expect(cartLine(page, ITEM).locator('.sum')).toHaveText('1 100 ₽');
  await expect(page.locator('#cart-total')).toContainText('Итого: 1 100 ₽');
  await expect(page.locator('#cart-total')).toContainText('Всего: 200 г');
  await expect(page.locator('#cart-count')).toHaveText('1 позиция');
  await expect(page.locator('#cart-total-badge')).toHaveText('· 1 позиция · 1 100 ₽');
  await expect(page.locator('#order-text')).toHaveValue(new RegExp(`• ${product.name} — 200 г — 1 100 ₽`));

  // Сумма закодирована в ссылке отправки.
  await openCart(page);
  await page.locator('#cust-phone').fill('+7 916 123-45-67');
  await expect(page.locator('#send-wa')).toHaveAttribute('aria-disabled', 'false');
  expect(await page.locator('#send-wa').getAttribute('href')).toContain('1%20100');
  await closeCart(page);

  await c.locator('[data-inc]').click();
  await expect(c.locator('input[data-qty]')).toHaveValue('250');
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('250');
  await expect(c.locator('.add-btn')).toHaveText('✓ В корзине · 250 г');

  await setGrams(c.locator('input[data-qty]'), 130);
  await expect(c.locator('input[data-qty]')).toHaveValue('150');
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('150');

  // Не число — корзина не меняется, поле возвращается к текущим граммам (fill не пускает буквы в type=number).
  await c.locator('input[data-qty]').selectText();
  await c.locator('input[data-qty]').pressSequentially('1e');
  await c.locator('input[data-qty]').press('Enter');
  await expect(c.locator('input[data-qty]')).toHaveValue('150');
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('150');

  // Редактирование граммов прямо в корзине.
  await openCart(page);
  await setGrams(cartLine(page, ITEM).locator('input'), 500);
  await expect(c.locator('input[data-qty]')).toHaveValue('500');
  await expect(c.locator('.preset[data-grams="500"]')).toHaveClass(/active/);
  await closeCart(page);

  await setGrams(c.locator('input[data-qty]'), 0);
  await expect(cartLine(page, ITEM)).toHaveCount(0);
  await expect(c.locator('.add-btn')).toHaveText('В корзину');
  await expect(c.locator('input[data-qty]')).toHaveValue('');
  await expect(page.locator('#cart-empty')).toHaveJSProperty('hidden', false);
  await expect(page.locator('#cart-count')).toHaveText('0 позиций');

  // «В корзину» без пресета — первый пресет; удаление крестиком (цель ≥ 44×44).
  await c.locator('.add-btn').click();
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('100');
  await openCart(page);
  const remove = cartLine(page, ITEM).locator('.remove');
  const box = await remove.boundingBox();
  expect(box.width, 'ширина кнопки удаления').toBeGreaterThanOrEqual(44);
  expect(box.height, 'высота кнопки удаления').toBeGreaterThanOrEqual(44);
  await remove.click();
  await expect(cartLine(page, ITEM)).toHaveCount(0);
});

test('3а. товар «по запросу»: сумма позиции и итог', async ({ page }) => {
  await openShop(page);
  const c = card(page, ITEM);
  expect(data.products.find((p) => p.id === ITEM).price, 'в products.json у товара нет цены').toBeNull();
  await expect(c.locator('.price')).toHaveText('Цена по запросу');
  await c.locator('.preset[data-grams="200"]').click();
  await expect(cartLine(page, ITEM).locator('.sum')).toHaveText('по запросу');
  await expect(page.locator('#cart-total')).toContainText('Итого: цена по запросу');
  await expect(page.locator('#order-text')).toHaveValue(/— 200 г — цена по запросу/);
  await expect(page.locator('#order-text')).toHaveValue(/Итого: цена по запросу/);
});

test('4. корзина переживает перезагрузку', async ({ page }) => {
  await openShop(page);
  await card(page, ITEM).locator('.preset[data-grams="200"]').click();
  await card(page, ITEM2).locator('.preset[data-grams="100"]').click();
  await openCart(page);
  await page.locator('#cust-name').fill('Анна');
  await expect(page.locator('#cart-count')).toHaveText('2 позиции');

  await page.reload();
  await expect(page.locator('#grid .card')).toHaveCount(data.products.length);
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('200');
  await expect(cartLine(page, ITEM2).locator('input')).toHaveValue('100');
  await expect(card(page, ITEM).locator('input[data-qty]')).toHaveValue('200');
  await expect(card(page, ITEM).locator('.add-btn')).toHaveText('✓ В корзине · 200 г');
  await expect(page.locator('#cust-name')).toHaveValue('Анна');
  await expect(page.locator('#cart-count')).toHaveText('2 позиции');
});

test('5. кнопки отправки: disabled без контакта, href с текстом заказа', async ({ page, context }) => {
  await useTestConfig(page);
  await openShop(page);
  const product = data.products.find((p) => p.id === ITEM);
  await card(page, ITEM).locator('.preset[data-grams="200"]').click();
  await openCart(page);

  const wa = page.locator('#send-wa');
  const tg = page.locator('#send-tg');
  const hint = page.locator('#send-hint');
  await expect(wa).toBeVisible();
  await expect(tg).toBeVisible();
  await expect(wa).toHaveAttribute('aria-disabled', 'true');
  await expect(tg).toHaveAttribute('aria-disabled', 'true');
  await expect(wa).toHaveAttribute('target', '_blank');
  await expect(wa).toHaveAttribute('rel', /noopener/);
  // Выключенная ссылка остаётся в табуляции и описана подсказкой.
  await expect(wa).not.toHaveAttribute('tabindex', '-1');
  await expect(wa).toHaveAttribute('aria-describedby', 'send-hint');
  await expect(hint).toHaveText('Укажите имя или телефон');
  await wa.click({ force: true }); // Playwright сам не кликает aria-disabled — а пользователь может
  await expect(hint).not.toHaveClass(/visually-hidden/);
  await expect(page.locator('#cust-name')).toBeFocused();

  await page.locator('#cust-phone').fill('+7 916 123-45-67');
  await expect(wa).toHaveAttribute('aria-disabled', 'false');
  await expect(tg).toHaveAttribute('aria-disabled', 'false');
  await expect(hint).toHaveClass(/visually-hidden/);
  expect(context.pages().length, 'disabled-ссылка не открыла окно').toBe(1);

  const href = await wa.getAttribute('href');
  expect(href.startsWith(`https://wa.me/${TEST_WA}?text=`)).toBe(true);
  const text = decodeURIComponent(href.split('?text=')[1]);
  expect(text).toContain(`• ${product.name} — 200 г`);
  expect(text).toContain('Телефон: +7 916 123-45-67');
  expect(text).toContain('Всего: 200 г');
  expect(await page.locator('#order-text').inputValue()).toBe(text);
  expect((await tg.getAttribute('href')).startsWith(`https://t.me/${TEST_TG}?text=`)).toBe(true);

  // MAX: чат с готовым текстом не умеет — ссылка на профиль, текст копируется в буфер при клике.
  const mx = page.locator('#send-max');
  await expect(mx).toBeVisible();
  await expect(mx).toHaveAttribute('aria-disabled', 'false');
  await expect(mx).toHaveAttribute('href', TEST_MAX);
  await context.route('**/max.ru/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>max stub</title>' }));
  const popup = context.waitForEvent('page');
  await mx.click();
  await (await popup).close();
  await expect(page.locator('#cart-notice')).toContainText('скопирован');

  // href обновляется при каждом изменении корзины.
  await closeCart(page);
  await card(page, ITEM).locator('[data-inc]').click();
  await expect.poll(() => orderTextOf(wa)).toContain(`• ${product.name} — 250 г`);
});

test('5а. кнопки отправки показаны только при заполненном CONFIG', async ({ page }) => {
  const { CONFIG } = await import(pathToFileURL(rootFile('js/config.js')).href);
  await openShop(page);
  await openCart(page);
  await (CONFIG.whatsapp ? expect(page.locator('#send-wa')).toBeVisible() : expect(page.locator('#send-wa')).toBeHidden());
  await (CONFIG.telegram ? expect(page.locator('#send-tg')).toBeVisible() : expect(page.locator('#send-tg')).toBeHidden());
  await (CONFIG.max ? expect(page.locator('#send-max')).toBeVisible() : expect(page.locator('#send-max')).toBeHidden());
});

test('6. «Повторить прошлый заказ» после отправки восстанавливает очищенную корзину', async ({ page, context }) => {
  await useTestConfig(page);
  // Внешний переход не нужен: отдаём заглушку вместо wa.me.
  await context.route('**/wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa stub</title>' }));
  await openShop(page);
  await expect(page.locator('#repeat-order')).toBeHidden();

  await card(page, ITEM).locator('.preset[data-grams="200"]').click();
  await card(page, ITEM2).locator('.preset[data-grams="500"]').click();
  await openCart(page);
  await page.locator('#cust-name').fill('Анна');
  await page.locator('#cust-phone').fill('+7 916 123-45-67');

  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('#send-wa').click(),
  ]);
  expect(popup.url()).toContain('wa.me/' + TEST_WA);
  await popup.close();

  await expect(page.locator('#repeat-order')).toBeVisible();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.locator('#clear-cart').click();
  await expect(page.locator('#cart-items li')).toHaveCount(0);
  expect(dialogs).toEqual(['Очистить корзину?']);
  await expect(card(page, ITEM).locator('.add-btn')).toHaveText('В корзину');

  // Пустая корзина — без подтверждения.
  await page.locator('#repeat-order').click();
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('200');
  await expect(cartLine(page, ITEM2).locator('input')).toHaveValue('500');
  await expect(card(page, ITEM).locator('.add-btn')).toHaveText('✓ В корзине · 200 г');
  await expect(page.locator('#cust-name')).toHaveValue('Анна');
  await expect(page.locator('#cust-phone')).toHaveValue('+7 916 123-45-67');
  expect(dialogs).toHaveLength(1);

  // Непустая корзина — с подтверждением; после него корзина заменяется прошлым заказом.
  await setGrams(cartLine(page, ITEM).locator('input'), 300);
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('300');
  await page.locator('#repeat-order').click();
  await expect.poll(() => dialogs).toEqual(['Очистить корзину?', 'Заменить текущую корзину прошлым заказом?']);
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('200');
});

test('7. лайтбокс: открытие/закрытие, inert, ловушка Tab, блокировка прокрутки', async ({ page }) => {
  await openShop(page);
  const lb = page.locator('#lightbox');
  await expect(lb).toBeHidden();
  await expect(lb).toHaveAttribute('role', 'dialog');
  await expect(lb).toHaveAttribute('aria-labelledby', 'lightbox-caption');

  // Открываем не с самого верха, чтобы проверить сохранение позиции прокрутки.
  const opener = card(page, 5).locator('.photo-btn');
  await opener.scrollIntoViewIfNeeded();
  await opener.hover(); // click больше не прокручивает — scrollY измеряем непосредственно перед ним
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await card(page, 5).locator('img.photo').click();
  await expect(lb).toBeVisible();
  await expect(page.locator('#lightbox-img')).toHaveAttribute('src', /images\/5\.jpg$/);
  await expect(page.locator('#lightbox-caption')).toHaveText(data.products.find((p) => p.id === 5).name);
  await expect(page.locator('#lightbox-close')).toBeFocused();
  await expect(page.locator('.layout')).toHaveAttribute('inert', '');
  await expect(page.locator('body')).toHaveClass(/lightbox-open/);
  expect(await page.evaluate(() => getComputedStyle(document.body).position)).toBe('fixed');

  // Tab и Shift+Tab не выходят за пределы лайтбокса.
  const inside = () => page.evaluate(() => document.getElementById('lightbox').contains(document.activeElement));
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await inside(), `Tab №${i + 1} остаётся в лайтбоксе`).toBe(true);
  }
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside(), `Shift+Tab №${i + 1} остаётся в лайтбоксе`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(lb).toBeHidden();
  await expect(page.locator('.layout')).not.toHaveAttribute('inert', '');
  await expect(page.locator('body')).not.toHaveClass(/lightbox-open/);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  await card(page, 2).locator('img.photo').click();
  await expect(lb).toBeVisible();
  await page.locator('#lightbox-close').click();
  await expect(lb).toBeHidden();

  await card(page, 3).locator('img.photo').click();
  await expect(lb).toBeVisible();
  await lb.click({ position: { x: 5, y: 5 } });
  await expect(lb).toBeHidden();
});

test('8. недоступная Google-таблица → каталог из products.json без ошибок', async ({ page }) => {
  await useTestConfig(page, { sheetId: 'INVALID_SHEET_ID_FOR_TEST' });
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
  let sheetRequests = 0;
  page.on('request', (r) => { if (r.url().includes('docs.google.com')) sheetRequests++; });
  await openShop(page);
  await expect.poll(() => sheetRequests, 'таблица запрашивалась').toBeGreaterThan(0);
  await expect.poll(() => warnings.some((w) => w.includes('[catalog]')), 'в консоли warning от каталога').toBe(true);
  await expect(page.locator('#grid .card')).toHaveCount(data.products.length);
  await expect(card(page, ITEM).locator('h2')).toHaveText(data.products.find((p) => p.id === ITEM).name);
  await card(page, ITEM).locator('.preset[data-grams="100"]').click();
  await expect(cartLine(page, ITEM)).toHaveCount(1);
});

test('9. копирование текста заказа', async ({ page }) => {
  await openShop(page);
  await card(page, ITEM).locator('.preset[data-grams="100"]').click();
  await openCart(page);
  const btn = page.locator('#copy-order');
  const status = page.locator('#copy-status');
  await expect(status).toHaveAttribute('role', 'status');
  await btn.click();
  await expect(btn).toHaveText(/Скопировано|выделите текст/);
  await expect(status).toHaveText(/Скопировано|выделите текст/);
  await expect(btn).toHaveText('Скопировать текст', { timeout: 4000 });
  await expect(status).toHaveText('');
});

test('10. «Очистить» удаляет позиции, но не имя и телефон', async ({ page }) => {
  await openShop(page);
  await card(page, ITEM).locator('.preset[data-grams="100"]').click();
  await openCart(page);
  await page.locator('#cust-name').fill('Анна');
  await page.locator('#cust-phone').fill('+7 916 123-45-67');
  page.once('dialog', (d) => d.accept());
  await page.locator('#clear-cart').click();
  await expect(page.locator('#cart-items li')).toHaveCount(0);
  await expect(page.locator('#cart-count')).toHaveText('0 позиций');
  await expect(page.locator('#cust-name')).toHaveValue('Анна');
  await expect(page.locator('#cust-phone')).toHaveValue('+7 916 123-45-67');
  await page.reload();
  await expect(page.locator('#grid .card')).toHaveCount(data.products.length);
  await expect(page.locator('#cust-name')).toHaveValue('Анна');
});

test('11. aria-live-счётчик не мутирует при вводе имени', async ({ page }) => {
  await openShop(page);
  await card(page, ITEM).locator('.preset[data-grams="100"]').click();
  await openCart(page);
  await expect(page.locator('#cart-count')).toHaveText('1 позиция');
  await page.evaluate(() => {
    window.__countMutations = 0;
    new MutationObserver((records) => { window.__countMutations += records.length; })
      .observe(document.getElementById('cart-count'), { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#cust-name').pressSequentially('Анна Петрова');
  await expect(page.locator('#order-text')).toHaveValue(/Имя: Анна Петрова/);
  expect(await page.evaluate(() => window.__countMutations)).toBe(0);
  // А при реальном изменении — обновляется.
  await page.locator('#cust-name').press('Escape');
  await closeCart(page);
  await card(page, ITEM2).locator('.preset[data-grams="100"]').click();
  await expect(page.locator('#cart-count')).toHaveText('2 позиции');
});

test('12. skip-link «К корзине» — первый в табуляции и фокусирует панель', async ({ page, browserName }) => {
  await openShop(page);
  const skip = page.locator('.skip-link');
  await expect(skip).toHaveAttribute('href', '#cart-bar');
  // Первый фокусируемый элемент документа — skip-link.
  expect(await page.evaluate(() => document.querySelector('a, button, input, textarea, summary, [tabindex]').className)).toBe('skip-link');
  if (browserName === 'chromium') {
    await page.keyboard.press('Tab');
  } else {
    await skip.focus(); // WebKit по Tab ссылки пропускает (настройка «tabsToLinks»)
  }
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#cart-bar')).toBeFocused();
  await expect(details(page)).toHaveJSProperty('open', true);
});

test.describe('плейсхолдер фото', () => {
  test.use({ consoleIgnore: [/images\/7\.jpg/] }); // 404 фото — намеренно, браузер пишет его в консоль как error

  test('13. фото не загрузилось → встроенный плейсхолдер', async ({ page }) => {
    await page.route('**/images/7.jpg', (route) => route.fulfill({ status: 404, body: '' }));
    await openShop(page);
    const img = card(page, 7).locator('img.photo');
    await img.scrollIntoViewIfNeeded();
    await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  });
});

test('13а. правка граммов в корзине и сразу ✕ — позиция удаляется с первого клика', async ({ page }) => {
  await openShop(page);
  await card(page, ITEM).locator('.preset[data-grams="200"]').click();
  await openCart(page);
  const line = cartLine(page, ITEM);
  await line.locator('input').fill('300'); // поле в фокусе, change ещё не было
  // mousedown → blur → change → перерисовка: строка должна остаться тем же узлом, иначе click теряется
  await line.locator('.remove').click();
  await expect(line).toHaveCount(0);
  await expect(page.locator('#cart-count')).toHaveText('0 позиций');
  await expect(card(page, ITEM).locator('.add-btn')).toHaveText('В корзину');
});

test('8а. таблица загрузилась → каталог заменён, недоступная позиция удалена из корзины, кэш записан', async ({ page }) => {
  const SHEET_ID = 'TEST_SHEET_ID';
  const NEW_PRICE = 999;
  await useTestConfig(page, { sheetId: SHEET_ID });
  const byId = (id) => data.products.find((p) => p.id === id);
  const label = (p) => data.categories[p.category];
  // Заголовки по SPEC §2.3; ITEM2 — «нет» в наличии, у ITEM новая цена, третьего товара в корзине не было.
  const csv = [
    'id,Название,Категория,Описание,Цена за 100 г,В наличии,Фото,Порядок',
    `1,${byId(1).name},${label(byId(1))},"Описание, с запятой",,да,,1`,
    `${ITEM},${byId(ITEM).name},${label(byId(ITEM))},Описание,${NEW_PRICE},да,,2`,
    `${ITEM2},${byId(ITEM2).name},${label(byId(ITEM2))},Описание,,нет,,3`,
  ].join('\r\n');
  // Таблицу отдаём только после того, как в корзину положены товары (иначе позиции не «пропадут»).
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/docs.google.com/**', async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      body: csv,
    });
  });
  await openShop(page);
  await card(page, ITEM).locator('.preset[data-grams="200"]').click();
  await card(page, ITEM2).locator('.preset[data-grams="100"]').click();
  await expect(page.locator('#cart-count')).toHaveText('2 позиции');
  release();

  await expect(page.locator('#grid .card')).toHaveCount(3);
  await expect(card(page, ITEM).locator('.price')).toHaveText(`${NEW_PRICE} ₽ / 100 г`);
  await expect(card(page, ITEM2)).toHaveClass(/unavailable/);
  await expect(page.locator('#cart-notice')).toContainText('1 позиция больше недоступна');
  await expect(cartLine(page, ITEM2)).toHaveCount(0);
  await expect(cartLine(page, ITEM).locator('input')).toHaveValue('200');
  await expect(cartLine(page, ITEM).locator('.sum')).toHaveText('1 998 ₽'); // 999 × 200 / 100
  await expect(page.locator('#cart-count')).toHaveText('1 позиция');
  const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('catalog:sheet')));
  expect(cache.sheetId).toBe(SHEET_ID);
  expect(cache.products.map((p) => p.id)).toEqual([1, ITEM, ITEM2]);
});

test.describe('телефон', () => {
  test.skip(({ viewport }) => viewport.width >= 900, 'только телефон');

  test('14. последняя карточка кликабельна при раскрытой корзине; отступ body = высота панели', async ({ page }) => {
    await openShop(page);
    await card(page, ITEM).locator('.preset[data-grams="100"]').click();
    await openCart(page);
    await expect(page.locator('body')).toHaveClass(/cart-open/);
    await expect.poll(() => page.evaluate(() => {
      const pad = parseFloat(getComputedStyle(document.body).paddingBottom);
      const h = document.getElementById('cart-bar').offsetHeight;
      return h > 100 && Math.abs(pad - h) <= 1;
    }), 'padding-bottom body равен высоте панели').toBe(true);

    const last = page.locator('#grid .card:not(.unavailable)').last();
    const lastId = Number(await last.getAttribute('data-id'));
    await last.locator('.preset[data-grams="100"]').click();
    await expect(cartLine(page, lastId).locator('input')).toHaveValue('100');
    await expect(page.locator('#cart-count')).toHaveText('2 позиции');
  });

  test('15. фокус в поле корзины: панель в потоке, после ухода — снова закреплена', async ({ page }) => {
    await openShop(page);
    await card(page, ITEM).locator('.preset[data-grams="100"]').click();
    await openCart(page);
    const bar = page.locator('#cart-bar');
    await page.locator('#cust-name').focus();
    await expect(bar).toHaveClass(/cart-bar--editing/);
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('static');
    await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom))).toBe(0);
    // Переход между полями панели режим не сбрасывает.
    await page.keyboard.press('Tab');
    await expect(page.locator('#cust-phone')).toBeFocused();
    await expect(bar).toHaveClass(/cart-bar--editing/);
    await page.locator('#search').focus();
    await expect(bar).not.toHaveClass(/cart-bar--editing/);
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  });
});

test.describe('десктоп', () => {
  test.skip(({ viewport }) => viewport.width < 900, 'только десктоп');

  test('16. Enter на заголовке корзины не сворачивает колонку', async ({ page }) => {
    await openShop(page);
    const summary = page.locator('#cart-details > summary');
    await expect(details(page)).toHaveJSProperty('open', true);
    await expect(summary).toHaveAttribute('tabindex', '-1');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(details(page)).toHaveJSProperty('open', true);
    await page.keyboard.press('Space');
    await expect(details(page)).toHaveJSProperty('open', true);
    await expect(page.locator('#order-text')).toBeVisible();
    // Заголовок не участвует в табуляции: Tab со skip-link уходит в поля панели.
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Tab');
    await expect(summary).not.toBeFocused();
  });
});
