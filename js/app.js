// Точка входа: каталог → корзина → интерфейс → service worker.
import { CONFIG } from './config.js';
import { loadCatalog } from './catalog.js';
import { createCart } from './cart.js';
import { initUI, renderCatalog, notifyRemovedItems } from './ui.js';

function showLoadError(err) {
  console.error('Каталог не загружен', err);
  const grid = document.getElementById('grid');
  grid.setAttribute('aria-busy', 'false');
  grid.innerHTML = '<p class="empty-msg">Не удалось загрузить каталог</p>';
}

async function main() {
  let cart = null;
  let pending = null; // таблица пришла раньше, чем создана корзина (практически невозможно, но дёшево)

  const onUpdate = (next) => {
    if (!cart) { pending = next; return; }
    const before = cart.getTotals().count;
    cart.setProducts(next.products); // позиции, которых больше нет или available=false, удаляются
    renderCatalog(next.products, next.categories);
    notifyRemovedItems(before - cart.getTotals().count);
  };

  const catalog = await loadCatalog({ config: CONFIG, onUpdate });
  cart = createCart({ config: CONFIG, products: catalog.products });
  initUI({ catalog, cart, config: CONFIG });
  if (pending) onUpdate(pending);
}

main().catch(showLoadError);

// Новая версия сайта установилась (SW сменил controller): предлагаем обновить, сами не перезагружаем.
function showUpdateBanner() {
  const box = document.getElementById('sw-update');
  if (!box || !box.hidden) return;
  box.hidden = false;
  document.getElementById('sw-reload').addEventListener('click', () => location.reload());
}

// Офлайн-режим: SW работает только на https и localhost; на file:// и http сайт живёт без него.
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || isLocal)) {
  const sw = navigator.serviceWorker;
  // Первая установка тоже меняет controller (clients.claim) — плашка нужна только при смене версии.
  const hadController = Boolean(sw.controller);
  sw.addEventListener('controllerchange', () => { if (hadController) showUpdateBanner(); });
  window.addEventListener('load', () => {
    sw.register('sw.js').catch((err) => console.warn('SW не зарегистрирован', err));
  });
}
