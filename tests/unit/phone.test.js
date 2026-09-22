import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneDigits, formatPhone, nextPhoneValue, hasPhoneDigits, isPhoneComplete } from '../../js/phone.js';

test('phoneDigits: 8 и 7 в начале, без кода, мусор, лимит 11 цифр', () => {
  const cases = [
    ['', ''],
    ['8', '7'],
    ['7', '7'],
    ['9', '79'],
    ['89156826702', '79156826702'],
    ['+7 (915) 682-67-02', '79156826702'],
    ['9156826702', '79156826702'],
    ['791568267029999', '79156826702'],
    ['abc', ''],
    [null, ''],
  ];
  for (const [raw, expected] of cases) assert.equal(phoneDigits(raw), expected, `raw=${raw}`);
});

test('formatPhone: постепенное форматирование', () => {
  const cases = [
    ['', ''],
    ['7', '+7 '],
    ['79', '+7 9'],
    ['7915', '+7 915'],
    ['79156', '+7 915 6'],
    ['7915682', '+7 915 682'],
    ['79156826', '+7 915 682-6'],
    ['791568267', '+7 915 682-67'],
    ['7915682670', '+7 915 682-67-0'],
    ['79156826702', '+7 915 682-67-02'],
    ['89156826702', '+7 915 682-67-02'],
    ['9156826702', '+7 915 682-67-02'],
  ];
  assert.equal(cases.length, 12);
  for (const [raw, expected] of cases) assert.equal(formatPhone(raw), expected, `raw=${raw}`);
});

test('nextPhoneValue: набор цифр по одной', () => {
  let v = '';
  for (const ch of '9156826702') v = nextPhoneValue(v + ch, { prev: v, inputType: 'insertText' });
  assert.equal(v, '+7 915 682-67-02');
});

test('nextPhoneValue: первая «8» заменяется на +7', () => {
  assert.equal(nextPhoneValue('8', { prev: '', inputType: 'insertText' }), '+7 ');
  assert.equal(nextPhoneValue('+7 8', { prev: '+7 ', inputType: 'insertText' }), '+7 8');
});

test('nextPhoneValue: backspace на разделителе удаляет цифру, а не залипает', () => {
  // «+7 915 682-67» → backspace стирает «7» → «+7 915 682-6»
  assert.equal(nextPhoneValue('+7 915 682-6', { prev: '+7 915 682-67', inputType: 'deleteContentBackward' }), '+7 915 682-6');
  // «+7 915 682-6» → backspace стирает «6» → «+7 915 682» (хвостовой «-» не остаётся)
  assert.equal(nextPhoneValue('+7 915 682-', { prev: '+7 915 682-6', inputType: 'deleteContentBackward' }), '+7 915 682');
  // «+7 915 682» → backspace: удалилась «2»
  assert.equal(nextPhoneValue('+7 915 68', { prev: '+7 915 682', inputType: 'deleteContentBackward' }), '+7 915 68');
  // «+7 915» → backspace ×3 → «+7 » → ещё раз → пусто
  assert.equal(nextPhoneValue('+7 91', { prev: '+7 915', inputType: 'deleteContentBackward' }), '+7 91');
  assert.equal(nextPhoneValue('+7', { prev: '+7 ', inputType: 'deleteContentBackward' }), '');
  assert.equal(nextPhoneValue('+7 ', { prev: '+7 9', inputType: 'deleteContentBackward' }), '+7 ');
});

test('nextPhoneValue: вставка номера целиком в любом формате', () => {
  assert.equal(nextPhoneValue('8 (915) 682-67-02', { prev: '', inputType: 'insertFromPaste' }), '+7 915 682-67-02');
  assert.equal(nextPhoneValue('+79156826702', { prev: '+7 ', inputType: 'insertFromPaste' }), '+7 915 682-67-02');
});

test('hasPhoneDigits / isPhoneComplete', () => {
  assert.equal(hasPhoneDigits(''), false);
  assert.equal(hasPhoneDigits('+7 '), false);
  assert.equal(hasPhoneDigits('+7 9'), true);
  assert.equal(isPhoneComplete('+7 915 682-67-0'), false);
  assert.equal(isPhoneComplete('+7 915 682-67-02'), true);
});
