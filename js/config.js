// Единственное место с контактами, id таблицы и текстами заказа (SPEC §3).
// Остальные модули читают значения только отсюда.
export const CONFIG = {
  shopName: 'Каталог сыров',
  whatsapp: '',            // международный формат без «+», напр. '79161234567'; пусто → кнопка скрыта
  telegram: '',            // username без «@»; пусто → кнопка скрыта
  sheetId: '1gyVSHrFPf_UrdDuxYtx6XOVTiYEarkQYSVrpUgynSVM', // id Google-таблицы; пусто → только products.json
  sheetName: '',           // имя листа; пусто → первый лист таблицы
  currency: '₽',
  weightPresets: [100, 200, 500],   // граммы
  weightStep: 50,                    // шаг «+/−»
  minWeight: 50,
  orderGreeting: 'Здравствуйте! Хочу заказать:',
  orderFooter: 'Подтвердите, пожалуйста, наличие, цену и способ доставки.',
};
