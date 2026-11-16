import assert from 'node:assert';
import { DeduplicationService } from '../src/services/deduplicator.js';
import { RawComment } from '../src/types.js';

const deduplicator = new DeduplicationService();

console.log('🧪 Запуск тестов DeduplicationService...');

// -------------------------------------------------------------
// ТЕСТ 1: cleanText, Unicode NFC, буква ё -> е, знаки препинания
// -------------------------------------------------------------
console.log('\n--- ТЕСТ 1: cleanText, Unicode NFC, ё -> е, знаки препинания (Defect 4.1 & 4.2) ---');

assert.strictEqual(deduplicator.cleanText('Участвуём!'), 'участвуем', 'Буква ё должна заменяться на е, ! удаляться');
assert.strictEqual(deduplicator.cleanText('  ЁЛКА  '), 'елка', 'Буква Ё в верхнем регистре должна преобразовываться в е');
assert.strictEqual(deduplicator.cleanText('—«Участвую»…'), 'участвую', 'Кавычки «», тире — и многоточие … должны очищаться');
assert.strictEqual(deduplicator.cleanText('“Победа”'), 'победа', 'Типографские кавычки “” должны очищаться');
assert.strictEqual(deduplicator.cleanText('\u200Bучаствую\uFEFF'), 'участвую', 'Zero-width пробелы должны удаляться');
assert.strictEqual(deduplicator.cleanText('+'), '+', 'Одиночный символ + должен сохраняться');

console.log('✅ ТЕСТ 1 пройден: cleanText корректно обрабатывает NFC, ё->е, знаки препинания и невидимые символы');

// -------------------------------------------------------------
// ТЕСТ 2: Оригинальный тест многострочного списка (strict exact mode)
// -------------------------------------------------------------
console.log('\n--- ТЕСТ 2: Строгий режим для списка кодовых слов ---');

const mockComments: RawComment[] = [
  {
    userId: 'user_1',
    username: 'Иван',
    profileUrl: 'https://vk.com/id1',
    commentText: 'Easy', // Совпадает со строкой 1
    createdAt: new Date('2026-11-01T10:00:00Z'),
  },
  {
    userId: 'user_2',
    username: 'Анна',
    profileUrl: 'https://vk.com/id2',
    commentText: 'Участвую!', // Совпадает со строкой 2 (со знаком !)
    createdAt: new Date('2026-11-01T10:05:00Z'),
  },
  {
    userId: 'user_3',
    username: 'Сергей',
    profileUrl: 'https://vk.com/id3',
    commentText: '+', // Совпадает со строкой 3
    createdAt: new Date('2026-11-01T10:02:00Z'),
  },
  {
    userId: 'user_4',
    username: 'Ольга',
    profileUrl: 'https://vk.com/id4',
    commentText: 'Easy и лишний текст тут', // Лишний текст!
    createdAt: new Date('2026-11-01T10:03:00Z'),
  },
  {
    userId: 'user_5',
    username: 'Павел',
    profileUrl: 'https://vk.com/id5',
    commentText: 'Привет, отличный розыгрыш', // Вообще нет слов из списка
    createdAt: new Date('2026-11-01T10:04:00Z'),
  },
];

const multilineInput = `Easy\nУчаствую\n+`;
const keywordsList = multilineInput.split('\n').map((l) => l.trim()).filter(Boolean);

const resExact = deduplicator.processComments(mockComments, 'first_wins', false, keywordsList, 'exact');

assert.strictEqual(resExact.participants.length, 3, 'Должно быть 3 валидных участника');
assert.strictEqual(resExact.duplicates.length, 2, 'Должно быть 2 исключенных');
console.log('✅ ТЕСТ 2 пройден: строгий режим списка слов работает корректно');

// -------------------------------------------------------------
// ТЕСТ 3: Сопоставление буквы ё / е в ключевых словах (Defect 4.1)
// -------------------------------------------------------------
console.log('\n--- ТЕСТ 3: Эквивалентность букв "ё" и "е" при поиске ---');

const yoComments: RawComment[] = [
  {
    userId: 'yo_user_1',
    username: 'UserЁ',
    profileUrl: 'https://vk.com/yo1',
    commentText: 'участвуём', // автор написал через ё
    createdAt: new Date('2026-11-01T10:00:00Z'),
  },
  {
    userId: 'yo_user_2',
    username: 'UserE',
    profileUrl: 'https://vk.com/yo2',
    commentText: 'участвуем', // автор написал через е
    createdAt: new Date('2026-11-01T10:01:00Z'),
  },
  {
    userId: 'yo_user_3',
    username: 'UserCaps',
    profileUrl: 'https://vk.com/yo3',
    commentText: 'УЧАСТВУЁМ!', // CAPS + ё + восклицательный знак
    createdAt: new Date('2026-11-01T10:02:00Z'),
  },
  {
    userId: 'yo_user_4',
    username: 'UserOther',
    profileUrl: 'https://vk.com/yo4',
    commentText: 'совсем другой текст',
    createdAt: new Date('2026-11-01T10:03:00Z'),
  },
];

// Ключевое слово задано через "е": "участвуем"
const resYo = deduplicator.processComments(yoComments, 'first_wins', false, ['участвуем'], 'exact');

assert.strictEqual(resYo.participants.length, 3, 'Все 3 комментария с "е" и "ё" должны совпасть с "участвуем"');
assert.strictEqual(resYo.duplicates.length, 1, 'Только UserOther должен быть исключен');
console.log('✅ ТЕСТ 3 пройден: "участвуем" и "участвуём" взаимно распознаются');

// -------------------------------------------------------------
// ТЕСТ 4: Честные границы слов в мягком режиме 'contains' (Defect 4.2)
// -------------------------------------------------------------
console.log('\n--- ТЕСТ 4: Границы слов (Unicode word boundaries) в режиме contains ---');

const boundaryComments: RawComment[] = [
  {
    userId: 'b_1',
    username: 'Колесо',
    profileUrl: 'https://vk.com/b1',
    commentText: 'крутится колесо', // содержит подстроку "лес", но это НЕ отдельное слово!
    createdAt: new Date('2026-11-01T10:00:00Z'),
  },
  {
    userId: 'b_2',
    username: 'Лесник',
    profileUrl: 'https://vk.com/b2',
    commentText: 'гуляю в лесу, люблю лес!', // содержит отдельное слово "лес"
    createdAt: new Date('2026-11-01T10:01:00Z'),
  },
  {
    userId: 'b_3',
    username: 'Лесной',
    profileUrl: 'https://vk.com/b3',
    commentText: 'лес и река', // содержит отдельное слово "лес"
    createdAt: new Date('2026-11-01T10:02:00Z'),
  },
];

const resBoundary = deduplicator.processComments(boundaryComments, 'first_wins', false, ['лес'], 'contains');

assert.strictEqual(resBoundary.participants.length, 2, 'Только комментарии с отдельным словом "лес" должны пройти');
assert.strictEqual(resBoundary.duplicates.length, 1, '"колесо" не должно матчиться на ключевое слово "лес"');
assert.strictEqual(resBoundary.duplicates[0].userId, 'b_1', 'Пользователь "Колесо" должен быть исключен');
console.log('✅ ТЕСТ 4 пройден: подстрока "колесо" не совпадает со словом "лес" благодаря Unicode word boundaries');

console.log('\n🎉 ВСЕ ТЕСТЫ DeduplicationService УСПЕШНО ПРОЙДЕНЫ!');
