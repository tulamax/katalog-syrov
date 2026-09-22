// Интерфейс: каталог, поиск/фильтры, корзина, лайтбокс, кнопки заказа.
// Все данные приходят из catalog.js/cart.js; здесь только DOM.
import { categoryLabel } from './catalog.js';
import { formatMoney, formatGrams, parseGramsInput } from './cart.js';
import { nextPhoneValue, hasPhoneDigits } from './phone.js';

const SEARCH_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 1800;
const NOTICE_MS = 8000;
const TAP_GRACE_MS = 400;   // iOS не фокусирует кнопки по тапу: ждём click после blur поля
const DESKTOP_MQ = '(min-width: 900px)';

// Плейсхолдер вместо фото, которое не загрузилось: без сетевых запросов.
const PHOTO_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">'
  + '<rect width="400" height="300" fill="#e9e5dc"/>'
  + '<text x="200" y="160" font-family="Arial, sans-serif" font-size="24" fill="#6a6a6a" text-anchor="middle">нет фото</text>'
  + '</svg>');

// Состояние модуля: один экземпляр UI на страницу.
const state = {
  cart: null,
  config: null,
  categories: {},
  products: [],
  query: '',
  cat: 'all',
  lastGrams: new Map(),   // id → граммы на момент последней синхронизации карточек
  lastLinesKey: '',       // чтобы не перерисовывать список корзины без надобности
  lightboxOpener: null,
  lightboxScrollY: 0,
  copyTimer: 0,
  noticeTimer: 0,
  editTimer: 0,
  barPointerTs: 0,        // последний pointerdown внутри панели корзины
  skipEditing: false,     // служебный фокус (fallback копирования) не должен включать режим редактирования
  editViewportH: 0,       // высота visualViewport на момент входа в режим редактирования (до клавиатуры)
};

const EAGER_PHOTOS = 4;   // первые карточки видны сразу — их фото грузим без lazy и с высоким приоритетом

const $ = (id) => document.getElementById(id);
const els = {};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// «3 позиции» — русские формы для счётчика.
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function money(n) {
  return `${formatMoney(n)} ${state.config.currency}`;
}

// aria-live-узлы: писать только при изменении строки, иначе читалка объявляет одно и то же.
const liveText = new WeakMap();
function setLiveText(el, text) {
  const prev = liveText.has(el) ? liveText.get(el) : el.textContent;
  if (prev === text) return;
  liveText.set(el, text);
  el.textContent = text;
}
function setLiveHTML(el, html) {
  const prev = liveText.has(el) ? liveText.get(el) : el.innerHTML;
  if (prev === html) return;
  liveText.set(el, html);
  el.innerHTML = html;
}

/* ===================== Каталог ===================== */

function cardHTML(p, index) {
  const presets = state.config.weightPresets
    .map((g) => `<button type="button" class="preset" data-grams="${g}" aria-label="${g} г — в корзину">${g} г</button>`)
    .join('');
  const price = p.price == null
    ? '<p class="price on-request">Цена по запросу</p>'
    : `<p class="price">${money(p.price)} / 100 г</p>`;
  const controls = p.available
    ? `<div class="presets">${presets}</div>
       <div class="qty-row">
         <button type="button" data-dec aria-label="Меньше на ${state.config.weightStep} г">−</button>
         <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="${state.config.weightStep}"
                placeholder="0" data-qty aria-label="Граммы: ${esc(p.name)}">
         <button type="button" data-inc aria-label="Больше на ${state.config.weightStep} г">+</button>
       </div>
       <button type="button" class="add-btn">В корзину</button>`
    : '<p class="stock-out">Нет в наличии</p>';
  const loading = index < EAGER_PHOTOS ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  return `<article class="card${p.available ? '' : ' unavailable'}" data-id="${p.id}">
    <button type="button" class="photo-btn" data-photo aria-label="Открыть фото: ${esc(p.name)}">
      <img class="photo" src="${esc(p.photo)}" alt="${esc(p.name)}" ${loading} decoding="async" width="400" height="300">
    </button>
    <div class="info">
      <span class="cat-tag">${esc(categoryLabel(p.category, state.categories))}</span>
      <h2>${esc(p.name)}</h2>
      <p class="desc">${esc(p.description)}</p>
      ${price}
      ${controls}
    </div>
  </article>`;
}

// Приводит элементы карточки к граммам из корзины (0 — не в корзине). Поле всегда = корзина.
function syncCard(card, grams) {
  const input = card.querySelector('input[data-qty]');
  if (!input) return; // «Нет в наличии» — управления нет
  input.value = grams ? String(grams) : '';
  card.querySelectorAll('.preset').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.grams) === grams);
  });
  const btn = card.querySelector('.add-btn');
  btn.textContent = grams ? `✓ В корзине · ${formatGrams(grams)}` : 'В корзину';
  btn.classList.toggle('in-cart', grams > 0);
}

function matches(p) {
  if (state.cat !== 'all' && p.category !== state.cat) return false;
  if (!state.query) return true;
  return (p.name + ' ' + p.description).toLowerCase().includes(state.query);
}

// Фильтрация без перерисовки: карточки прячутся атрибутом hidden.
function applyFilter() {
  let shown = 0;
  const visible = new Set(state.products.filter(matches).map((p) => String(p.id)));
  els.grid.querySelectorAll('.card').forEach((card) => {
    const on = visible.has(card.dataset.id);
    card.hidden = !on;
    if (on) shown++;
  });
  const empty = els.grid.querySelector('[data-empty]');
  if (empty) empty.hidden = shown > 0;
}

function renderCategories(categories) {
  const html = ['<button type="button" class="cat-btn" data-cat="all">Все</button>']
    .concat(Object.entries(categories).map(([code, label]) =>
      `<button type="button" class="cat-btn" data-cat="${esc(code)}">${esc(label)}</button>`))
    .join('');
  els.categories.innerHTML = html;
  if (state.cat !== 'all' && !(state.cat in categories)) state.cat = 'all';
  els.categories.querySelectorAll('.cat-btn').forEach((b) => {
    const on = b.dataset.cat === state.cat;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// Элементы карточки, в которые стоит вернуть фокус после перерисовки каталога.
const CARD_FOCUS_TARGETS = ['input[data-qty]', '.photo-btn', '.add-btn', '[data-inc]', '[data-dec]'];

// Где в карточке стоит фокус: {id, selector, value} или null. Нужно, чтобы приход таблицы
// не выбросил пользователя из поля граммов посреди ввода.
function focusedCardTarget() {
  const el = document.activeElement;
  if (!el || !els.grid.contains(el)) return null;
  const card = el.closest('.card');
  if (!card) return null;
  let selector = CARD_FOCUS_TARGETS.find((s) => el.matches(s));
  if (!selector && el.matches('.preset')) selector = `.preset[data-grams="${el.dataset.grams}"]`;
  if (!selector) return null;
  return { id: card.dataset.id, selector, value: el.matches('input') ? el.value : null };
}

function restoreCardFocus(target) {
  if (!target) return;
  const el = els.grid.querySelector(`.card[data-id="${target.id}"] ${target.selector}`);
  if (!el) return;
  el.focus({ preventScroll: true });
  // Введённое, но ещё не применённое значение возвращаем в поле; focusout применит его (см. onGridFocusOut).
  if (target.value && el.matches('input') && el.value !== target.value) {
    el.value = target.value;
    el.dataset.restored = '1';
  }
}

// Полная отрисовка каталога одним innerHTML. Вызывается при старте и когда пришла таблица.
export function renderCatalog(products, categories) {
  closeLightbox(); // фото могло относиться к карточке, которой больше нет
  const focused = focusedCardTarget();
  if (categories && categories !== state.categories) {
    state.categories = categories;
    renderCategories(categories);
  }
  state.products = products.slice().sort((a, b) => a.sort - b.sort);
  els.grid.innerHTML = state.products.map((p, i) => cardHTML(p, i)).join('')
    + '<p class="empty-msg" data-empty hidden>Ничего не найдено</p>';
  els.grid.setAttribute('aria-busy', 'false');
  state.lastGrams = new Map();
  state.lightboxOpener = null; // старые карточки отсоединены — фокус возвращать некуда
  syncCards();
  applyFilter();
  restoreCardFocus(focused);
  // Названия/цены в корзине могли измениться при том же наборе id — строки обновятся точечно.
  if (els.cartItems) renderCartPanel();
}

// Обновляет только карточки, у которых изменились граммы.
function syncCards() {
  const cart = state.cart;
  const next = new Map(cart.items);
  const ids = new Set([...state.lastGrams.keys(), ...next.keys()]);
  ids.forEach((id) => {
    const was = state.lastGrams.get(id) || 0;
    const now = next.get(id) || 0;
    if (was === now) return;
    const card = els.grid.querySelector(`.card[data-id="${id}"]`);
    if (card) syncCard(card, now);
  });
  state.lastGrams = next;
}

// Число из поля, если оно в фокусе и содержит число; иначе null.
function gramsInFocusedField(input) {
  if (!input || document.activeElement !== input) return null;
  return parseGramsInput(input.value);
}

// Применяет введённые граммы: не число → корзина не трогается; поле всегда ← корзина.
function applyTypedGrams(input, id) {
  const n = parseGramsInput(input.value);
  if (n !== null) state.cart.setGrams(id, n);
  const g = state.cart.getGrams(id);
  input.value = g ? String(g) : '';
  return g;
}

function onGridClick(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = Number(card.dataset.id);
  const cart = state.cart;
  const cfg = state.config;
  const input = card.querySelector('input[data-qty]');
  const preset = e.target.closest('.preset');
  if (preset) {
    cart.setGrams(id, Number(preset.dataset.grams));
    syncCard(card, cart.getGrams(id));
    return;
  }
  const inc = e.target.closest('[data-inc]');
  if (inc || e.target.closest('[data-dec]')) {
    const typed = gramsInFocusedField(input);
    const base = typed !== null ? typed : cart.getGrams(id);
    const next = inc ? Math.max(base + cfg.weightStep, cfg.minWeight) : base - cfg.weightStep;
    cart.setGrams(id, next);
    syncCard(card, cart.getGrams(id));
    return;
  }
  if (e.target.closest('.add-btn')) {
    const typed = input ? parseGramsInput(input.value) : null;
    const grams = typed !== null && typed > 0 ? typed : (cart.getGrams(id) || cfg.weightPresets[0]);
    cart.setGrams(id, grams);
    syncCard(card, cart.getGrams(id));
    return;
  }
  if (e.target.closest('[data-photo]')) {
    const img = card.querySelector('img.photo');
    openLightbox(img.currentSrc || img.src, img.alt, e.target.closest('[data-photo]'));
  }
}

// Ввод граммов вручную: применяем по change (blur/Enter), чтобы не «ломать» число во время набора.
function onGridChange(e) {
  const input = e.target.closest('input[data-qty]');
  if (!input) return;
  const card = input.closest('.card');
  delete input.dataset.restored;
  syncCard(card, applyTypedGrams(input, Number(card.dataset.id)));
}

// Ушли из поля без change (например, стёрли всё): вернуть граммы из корзины.
// Значение, восстановленное после перерисовки каталога, браузер не считает «изменённым»
// и change не пошлёт — применяем его сами.
function onGridFocusOut(e) {
  const input = e.target.closest('input[data-qty]');
  if (!input) return;
  const card = input.closest('.card');
  if (input.dataset.restored) {
    delete input.dataset.restored;
    syncCard(card, applyTypedGrams(input, Number(card.dataset.id)));
    return;
  }
  const g = state.cart.getGrams(Number(card.dataset.id));
  input.value = g ? String(g) : '';
}

function onGridKeydown(e) {
  if (e.key === 'Enter' && e.target.matches('input[data-qty]')) {
    e.preventDefault();
    e.target.blur(); // blur → change → setGrams
  }
}

// Фото не загрузилось → плейсхолдер (один раз, чтобы не зациклиться).
function onGridImageError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('photo') || img.dataset.fallback) return;
  img.dataset.fallback = '1';
  img.src = PHOTO_FALLBACK;
}

/* ===================== Шапка ===================== */

function initHeader() {
  let timer = 0;
  els.search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = els.search.value.trim().toLowerCase();
      applyFilter();
    }, SEARCH_DEBOUNCE_MS);
  });
  els.categories.addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-btn');
    if (!btn) return;
    state.cat = btn.dataset.cat;
    els.categories.querySelectorAll('.cat-btn').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    applyFilter();
  });
}

/* ===================== Корзина ===================== */

function cartLineHTML({ product, grams, sum }) {
  const sumHTML = sum == null
    ? '<span class="sum on-request">по запросу</span>'
    : `<span class="sum">${money(sum)}</span>`;
  return `<li data-id="${product.id}">
    <span class="name">${esc(product.name)}</span>
    <span class="grams">
      <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" step="${state.config.weightStep}"
             value="${grams}" data-cart-qty aria-label="Граммы: ${esc(product.name)}">
      <span class="unit">г</span>
    </span>
    ${sumHTML}
    <button type="button" class="remove" data-remove aria-label="Удалить: ${esc(product.name)}">✕</button>
  </li>`;
}

function sendURL(kind, text) {
  const q = `?text=${encodeURIComponent(text)}`;
  if (kind === 'wa') return `https://wa.me/${state.config.whatsapp}${q}`;
  if (kind === 'tg') return `https://t.me/${state.config.telegram}${q}`;
  // sms: RFC 5724 — «?body=» понимают и iOS (с 8-й версии), и Android
  if (kind === 'sms') return `sms:+${String(state.config.sms).replace(/\D/g, '')}?body=${encodeURIComponent(text)}`;
  // MAX не умеет открывать чат с человеком с готовым текстом — только профиль;
  // текст заказа копируется в буфер при клике (см. initCart).
  const m = String(state.config.max).trim();
  return /^https?:\/\//i.test(m) ? m : `https://max.ru/${m.replace(/^@/, '')}`;
}

// Ссылка «выключена»: без href (ctrl/средний клик, long-press ничего не откроют), но остаётся
// в табуляции (tabindex="0", role="link" в разметке) и описана подсказкой (aria-describedby="send-hint").
function setSendLink(link, href, disabled) {
  link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  link.classList.toggle('is-disabled', disabled);
  if (disabled) link.removeAttribute('href');
  else if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

// Точечное обновление строки корзины: узлы не пересоздаются, чтобы не терять click,
// начатый (mousedown) до blur поля граммов.
function updateCartLine(li, { product, grams, sum }) {
  const name = li.querySelector('.name');
  if (name.textContent !== product.name) {
    name.textContent = product.name;
    li.querySelector('input[data-cart-qty]').setAttribute('aria-label', `Граммы: ${product.name}`);
    li.querySelector('[data-remove]').setAttribute('aria-label', `Удалить: ${product.name}`);
  }
  const input = li.querySelector('input[data-cart-qty]');
  if (document.activeElement !== input && input.value !== String(grams)) input.value = String(grams);
  const sumEl = li.querySelector('.sum');
  const onRequest = sum == null;
  const sumText = onRequest ? 'по запросу' : money(sum);
  if (sumEl.textContent !== sumText) sumEl.textContent = sumText;
  sumEl.classList.toggle('on-request', onRequest);
}

// Сообщение в панели корзины (role="status"); само исчезает.
export function showCartNotice(text) {
  clearTimeout(state.noticeTimer);
  els.cartNotice.textContent = text;
  state.noticeTimer = setTimeout(() => { els.cartNotice.textContent = ''; }, NOTICE_MS);
}

// Каталог обновился, и часть позиций корзины пропала (app.js).
export function notifyRemovedItems(n) {
  if (!(n > 0)) return;
  const tail = n === 1 ? 'больше недоступна и удалена' : 'больше недоступны и удалены';
  showCartNotice(`${n} ${plural(n, 'позиция', 'позиции', 'позиций')} ${tail} из корзины`);
}

// Точечное обновление панели корзины; список позиций пересобирается только если он изменился.
function renderCartPanel() {
  const cart = state.cart;
  const lines = cart.getLines();
  const totals = cart.getTotals();
  const text = cart.getOrderText();

  // Ключ — только набор id и их порядок: при том же наборе строки обновляются точечно.
  const key = lines.map((l) => l.product.id).join('|');
  if (key !== state.lastLinesKey) {
    els.cartItems.innerHTML = lines.map(cartLineHTML).join('');
    state.lastLinesKey = key;
  } else {
    for (const line of lines) {
      const li = els.cartItems.querySelector(`li[data-id="${line.product.id}"]`);
      if (li) updateCartLine(li, line);
    }
  }

  const empty = totals.count === 0;
  els.cartEmpty.hidden = !empty;
  const countText = `${totals.count} ${plural(totals.count, 'позиция', 'позиции', 'позиций')}`;
  if (empty) {
    setLiveHTML(els.cartTotal, '');
    els.orderText.value = '';
    setLiveText(els.cartBadge, '');
  } else {
    const onlyOnRequest = totals.sum === 0 && totals.hasOnRequest;
    const sumText = onlyOnRequest
      ? 'Итого: цена по запросу'
      : `Итого: ${money(totals.sum)}${totals.hasOnRequest ? ' <small>(+ позиции по запросу)</small>' : ''}`;
    setLiveHTML(els.cartTotal, `${sumText}<br><small>Всего: ${formatGrams(totals.grams)}</small>`);
    if (els.orderText.value !== text) els.orderText.value = text;
    setLiveText(els.cartBadge, `· ${countText}${totals.sum > 0 ? ` · ${money(totals.sum)}` : ''}`);
  }
  setLiveText(els.cartCount, countText);

  // Ссылки отправки: href всегда актуален, чтобы переход был синхронным (Safari).
  const canSend = cart.canSend();
  if (state.config.whatsapp) setSendLink(els.sendWa, sendURL('wa', text), !canSend);
  if (state.config.telegram) setSendLink(els.sendTg, sendURL('tg', text), !canSend);
  if (state.config.max) setSendLink(els.sendMax, sendURL('max', text), !canSend);
  if (state.config.sms) setSendLink(els.sendSms, sendURL('sms', text), !canSend);
  const c = cart.customer;
  const needContact = !empty && !(c.name || '').trim() && !(c.phone || '').trim();
  const hasLinks = Boolean(state.config.whatsapp || state.config.telegram || state.config.max || state.config.sms);
  els.sendHint.classList.toggle('visually-hidden', !(needContact && hasLinks));

  els.copyOrder.disabled = empty;
  els.clearCart.disabled = empty;
  els.repeatOrder.hidden = !cart.hasLastOrder();

  // Поля покупателя могли смениться извне (восстановление, «повторить заказ»).
  for (const [k, el] of Object.entries(els.customer)) {
    const v = c[k] || '';
    if (el.value !== v && document.activeElement !== el) el.value = v;
  }
}

// Телефон: код страны набирать не нужно — «+7 » появляется от первой цифры («9» → «+7 9»,
// привычные «8» или «7» в начале превращаются в «+7 »), дальше номер форматируется на лету.
// Подставлять префикс при фокусе нельзя: тогда «8», набранная по привычке, попадала бы в номер.
// В корзину уходит только номер с цифрами после префикса — один «+7 » не считается контактом.
function initPhoneField(input, cart) {
  let prev = input.value;
  const commit = () => cart.setCustomer({ phone: hasPhoneDigits(input.value) ? input.value : '' });
  input.addEventListener('input', (e) => {
    const next = nextPhoneValue(input.value, { prev, inputType: e.inputType || '' });
    if (next !== input.value) {
      input.value = next;
      input.setSelectionRange(next.length, next.length);
    }
    prev = next;
    commit();
  });
  input.addEventListener('blur', () => {
    if (!hasPhoneDigits(input.value)) { input.value = ''; prev = ''; commit(); }
  });
}

async function copyOrder() {
  const text = els.orderText.value;
  if (!text) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // iOS Safari: выделить readonly-textarea можно только через contentEditable.
    // Служебный фокус не должен двигать страницу и включать режим редактирования панели.
    const ta = els.orderText;
    state.skipEditing = true;
    try {
      ta.removeAttribute('readonly');
      ta.contentEditable = 'true';
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(0, ta.value.length);
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.contentEditable = 'false';
      ta.setAttribute('readonly', '');
      ta.blur();
    } finally {
      state.skipEditing = false;
    }
  }
  const btn = els.copyOrder;
  clearTimeout(state.copyTimer);
  const msg = ok ? '✓ Скопировано' : 'Не удалось — выделите текст ниже';
  btn.textContent = msg;
  btn.classList.toggle('copied', ok);
  els.copyStatus.textContent = ok ? 'Скопировано' : 'Не удалось скопировать — выделите текст заказа';
  state.copyTimer = setTimeout(() => {
    btn.textContent = 'Скопировать текст';
    btn.classList.remove('copied');
    els.copyStatus.textContent = '';
  }, COPY_FEEDBACK_MS);
}

function initCart() {
  const cart = state.cart;
  const cfg = state.config;

  els.sendWa.hidden = !cfg.whatsapp;
  els.sendTg.hidden = !cfg.telegram;
  els.sendMax.hidden = !cfg.max;
  els.sendSms.hidden = !cfg.sms;

  // Список позиций: редактирование граммов и удаление.
  els.cartItems.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) cart.remove(Number(btn.closest('li').dataset.id));
  });
  els.cartItems.addEventListener('change', (e) => {
    const input = e.target.closest('input[data-cart-qty]');
    if (input) applyTypedGrams(input, Number(input.closest('li').dataset.id));
  });
  els.cartItems.addEventListener('focusout', (e) => {
    const input = e.target.closest('input[data-cart-qty]');
    if (!input) return;
    const g = cart.getGrams(Number(input.closest('li').dataset.id));
    if (g) input.value = String(g);
  });
  els.cartItems.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[data-cart-qty]')) { e.preventDefault(); e.target.blur(); }
  });

  // Данные покупателя.
  for (const [k, el] of Object.entries(els.customer)) {
    if (k === 'phone') continue; // телефон — ниже, со своим форматированием
    el.addEventListener('input', () => cart.setCustomer({ [k]: el.value }));
  }
  initPhoneField(els.customer.phone, cart);
  els.customerForm.addEventListener('submit', (e) => e.preventDefault());

  // Кнопки отправки — делегированный клик: сохраняем «последний заказ» и даём ссылке сработать.
  // Выключенная ссылка (без href) объясняет, чего не хватает, и ведёт к полю имени.
  const sendLinkOf = (e) => e.target.closest('#send-wa, #send-tg, #send-max, #send-sms');
  const isDisabledLink = (link) => link.getAttribute('aria-disabled') === 'true';
  const explainDisabled = () => {
    if (cart.getTotals().count === 0) return;
    els.sendHint.classList.remove('visually-hidden');
    els.customer.name.focus();
  };
  els.cartActions.addEventListener('click', (e) => {
    const link = sendLinkOf(e);
    if (!link) return;
    if (isDisabledLink(link)) { e.preventDefault(); explainDisabled(); return; }
    cart.saveLastOrder();
    els.repeatOrder.hidden = !cart.hasLastOrder();
    if (link.id === 'send-max') {
      // Копируем в буфер внутри жеста пользователя, не дожидаясь результата — ссылка открывается сразу.
      const text = els.orderText.value;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
      showCartNotice('Текст заказа скопирован — вставьте его в чат MAX');
    }
  });
  // Средний клик и ctrl/⌘-клик — обход через auxclick; без href браузер и так ничего не откроет,
  // но у выключенной ссылки не должно быть и побочных действий.
  els.cartActions.addEventListener('auxclick', (e) => {
    const link = sendLinkOf(e);
    if (link && isDisabledLink(link)) e.preventDefault();
  });
  // Без href Enter на ссылке click не порождает — обрабатываем клавиатуру сами.
  els.cartActions.addEventListener('keydown', (e) => {
    const link = sendLinkOf(e);
    if (!link || !isDisabledLink(link) || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    explainDisabled();
  });

  els.copyOrder.addEventListener('click', copyOrder);
  els.repeatOrder.addEventListener('click', () => {
    if (cart.getTotals().count > 0 && !window.confirm('Заменить текущую корзину прошлым заказом?')) return;
    if (!cart.restoreLastOrder()) showCartNotice('Позиции прошлого заказа сейчас недоступны');
  });
  els.clearCart.addEventListener('click', () => {
    if (window.confirm('Очистить корзину?')) cart.clearItems(); // имя/телефон остаются
  });

  initCartBar();

  cart.subscribe(() => {
    renderCartPanel();
    syncCards();
  });
  renderCartPanel();
}

// Раскладка панели: телефон — свёрнутая нижняя полоса, десктоп — всегда раскрытая колонка;
// отступ body под панель; режим редактирования под клавиатуру iOS; skip-link.
function initCartBar() {
  const bar = els.cartBar;
  const details = els.cartDetails;
  const summary = els.cartSummary;
  const mq = window.matchMedia(DESKTOP_MQ);
  const isDesktop = () => mq.matches;

  // body.padding-bottom = фактическая высота панели (CSS-переменная --cart-bar-h).
  const updateBarHeight = () => {
    const inFlow = isDesktop() || bar.classList.contains('cart-bar--editing');
    const h = inFlow ? 0 : bar.offsetHeight;
    document.documentElement.style.setProperty('--cart-bar-h', `${h}px`);
  };

  const exitEditing = () => {
    clearTimeout(state.editTimer);
    if (!bar.classList.contains('cart-bar--editing')) return;
    bar.classList.remove('cart-bar--editing');
    updateBarHeight();
  };

  const enterEditing = (field) => {
    if (isDesktop()) return;
    clearTimeout(state.editTimer);
    if (!bar.classList.contains('cart-bar--editing')) {
      bar.classList.add('cart-bar--editing');
      // focusin приходит до появления клавиатуры — это высота экрана без неё.
      state.editViewportH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      updateBarHeight();
    }
    requestAnimationFrame(() => field.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const applyLayout = () => {
    const desktop = isDesktop();
    if (desktop) summary.setAttribute('tabindex', '-1'); else summary.removeAttribute('tabindex');
    if (desktop) exitEditing();
    details.open = desktop;
    document.body.classList.toggle('cart-open', details.open);
    updateBarHeight();
  };

  details.addEventListener('toggle', () => {
    if (isDesktop() && !details.open) { details.open = true; return; } // колонку не сворачиваем
    document.body.classList.toggle('cart-open', details.open);
    updateBarHeight();
  });

  applyLayout();
  (mq.addEventListener ? mq.addEventListener('change', applyLayout) : mq.addListener(applyLayout));
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateBarHeight).observe(bar);
  window.addEventListener('resize', updateBarHeight);

  // Клавиатура iOS: поле в панели → панель в потоке, поле по центру экрана.
  bar.addEventListener('focusin', (e) => {
    if (state.skipEditing) return; // служебный фокус (fallback копирования)
    if (e.target.matches('input, textarea')) enterEditing(e.target);
  });
  // Клавиатура закрыта кнопкой «Готово», фокус остался в поле: focusout не будет — ловим
  // восстановление visualViewport. Проверяем и против innerHeight (iOS: он не меняется),
  // и против высоты на момент входа (Chrome с resizes-content уменьшает и innerHeight).
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!bar.classList.contains('cart-bar--editing')) return;
      const h = window.visualViewport.height;
      if (h >= 0.85 * window.innerHeight && h >= 0.85 * state.editViewportH) exitEditing();
    });
  }
  bar.addEventListener('pointerdown', () => { state.barPointerTs = Date.now(); });
  bar.addEventListener('focusout', (e) => {
    if (e.relatedTarget && bar.contains(e.relatedTarget)) return;
    clearTimeout(state.editTimer);
    // Тап по кнопке панели (iOS не даёт ей фокус): не двигать панель, пока click не отработал.
    const wait = Date.now() - state.barPointerTs < TAP_GRACE_MS ? TAP_GRACE_MS : 0;
    state.editTimer = setTimeout(() => {
      if (!bar.contains(document.activeElement)) exitEditing();
    }, wait);
  });

  // «К корзине»: раскрыть панель и поставить фокус на неё.
  els.skipLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (!isDesktop()) details.open = true;
    bar.focus();
  });
}

/* ===================== Лайтбокс ===================== */

// Всё вне лайтбокса недоступно для фокуса и читалки, пока он открыт.
function setOutsideInert(on) {
  for (const el of document.body.children) {
    if (el === els.lightbox || el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT') continue;
    if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
  }
}

function openLightbox(src, caption, opener) {
  state.lightboxOpener = opener || document.activeElement;
  els.lightboxImg.src = src;
  els.lightboxImg.alt = caption;
  els.lightboxCaption.textContent = caption;
  // Блокировка прокрутки фона без прыжка: фиксируем body на текущем scrollY.
  state.lightboxScrollY = window.scrollY;
  document.body.style.top = `-${state.lightboxScrollY}px`;
  document.body.classList.add('lightbox-open');
  setOutsideInert(true);
  els.lightbox.hidden = false;
  els.lightboxClose.focus();
}

function closeLightbox() {
  if (els.lightbox.hidden) return;
  els.lightbox.hidden = true;
  els.lightboxImg.removeAttribute('src');
  setOutsideInert(false);
  document.body.classList.remove('lightbox-open');
  document.body.style.top = '';
  window.scrollTo(0, state.lightboxScrollY);
  const back = state.lightboxOpener;
  state.lightboxOpener = null;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  else els.grid.focus();
}

function initLightbox() {
  els.lightbox.addEventListener('click', closeLightbox); // тап в любом месте закрывает
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });
  // Ловушка Tab: фокус ходит по кругу «закрыть» ↔ фото.
  els.lightbox.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const ring = [els.lightboxClose, els.lightboxImg];
    const i = ring.indexOf(document.activeElement);
    const next = e.shiftKey
      ? (i <= 0 ? ring.length - 1 : i - 1)
      : (i < 0 || i === ring.length - 1 ? 0 : i + 1);
    e.preventDefault();
    ring[next].focus();
  });
}

/* ===================== Точка входа ===================== */

export function initUI({ catalog, cart, config }) {
  state.cart = cart;
  state.config = config;

  Object.assign(els, {
    grid: $('grid'), search: $('search'), categories: $('categories'), cartCount: $('cart-count'),
    skipLink: document.querySelector('.skip-link'),
    cartBar: $('cart-bar'), cartDetails: $('cart-details'), cartBadge: $('cart-total-badge'),
    cartSummary: document.querySelector('#cart-details > summary'), cartNotice: $('cart-notice'),
    cartEmpty: $('cart-empty'), cartItems: $('cart-items'), cartTotal: $('cart-total'),
    customerForm: $('customer-form'), sendHint: $('send-hint'), cartActions: document.querySelector('.cart-actions'),
    sendWa: $('send-wa'), sendTg: $('send-tg'), sendMax: $('send-max'), sendSms: $('send-sms'), copyOrder: $('copy-order'), copyStatus: $('copy-status'),
    repeatOrder: $('repeat-order'), clearCart: $('clear-cart'), orderText: $('order-text'),
    lightbox: $('lightbox'), lightboxImg: $('lightbox-img'), lightboxCaption: $('lightbox-caption'),
    lightboxClose: $('lightbox-close'),
    customer: { name: $('cust-name'), phone: $('cust-phone'), address: $('cust-address'), comment: $('cust-comment') },
  });

  document.title = config.shopName;
  $('shop-name-text').textContent = config.shopName;

  els.grid.addEventListener('click', onGridClick);
  els.grid.addEventListener('change', onGridChange);
  els.grid.addEventListener('focusout', onGridFocusOut);
  els.grid.addEventListener('keydown', onGridKeydown);
  els.grid.addEventListener('error', onGridImageError, true); // error не всплывает — ловим на захвате

  initHeader();
  initLightbox();
  renderCatalog(catalog.products, catalog.categories);
  initCart();
}
