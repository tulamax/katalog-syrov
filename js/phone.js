// Российский номер в поле «Телефон»: «+7 » подставляется сам, ввод форматируется на лету.
// Чистые функции без DOM — покрыты юнит-тестами.

export const PHONE_PREFIX = '+7 ';
const MAX_DIGITS = 11; // 7 + 10 цифр

// Нормализация к цифрам с ведущей «7»: «8 915…» → «7915…», «915…» → «7915…».
export function phoneDigits(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d[0] === '8' || d[0] === '7') d = '7' + d.slice(1);
  else d = '7' + d;
  return d.slice(0, MAX_DIGITS);
}

// «7915682670» → «+7 915 682-67-0»; «7» → «+7 »; «» → «».
export function formatPhone(raw) {
  const d = phoneDigits(raw);
  if (!d) return '';
  const rest = d.slice(1);
  let out = PHONE_PREFIX;
  if (rest.length) out += rest.slice(0, 3);
  if (rest.length > 3) out += ' ' + rest.slice(3, 6);
  if (rest.length > 6) out += '-' + rest.slice(6, 8);
  if (rest.length > 8) out += '-' + rest.slice(8, 10);
  return out;
}

// Полный ли номер (11 цифр) — для подсказок; для отправки достаточно любого ввода.
export function isPhoneComplete(raw) {
  return phoneDigits(raw).length === MAX_DIGITS;
}

// Есть ли в поле что-то кроме подставленного префикса.
export function hasPhoneDigits(raw) {
  return phoneDigits(raw).length > 1;
}

// Реакция на событие input: возвращает новое значение поля.
// Backspace на разделителе (« », «-») иначе «залипал» бы: цифры те же → форматтер вернул бы разделитель.
export function nextPhoneValue(value, { prev = '', inputType = '' } = {}) {
  let d = phoneDigits(value);
  const deleting = inputType.startsWith('delete');
  if (deleting && d === phoneDigits(prev) && value.length < prev.length) {
    if (d === '7') return '';                   // backspace по самому префиксу — очищаем поле целиком
    d = d.slice(0, -1);
  }
  return formatPhone(d);
}
