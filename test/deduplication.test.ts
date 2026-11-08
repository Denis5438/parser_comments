import { DeduplicationService } from '../src/services/deduplicator.js';
import { RawComment } from '../src/types.js';

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

const deduplicator = new DeduplicationService();

// Имитируем ввод пользователя с переносами строк
const multilineInput = `Easy\nУчаствую\n+`;
const keywordsList = multilineInput.split('\n').map((l) => l.trim()).filter(Boolean);

console.log('Список введенных строк:', keywordsList);

console.log('\n--- ТЕСТ: Строгий режим для списка слов ---');
const resExact = deduplicator.processComments(mockComments, 'first_wins', false, keywordsList, 'exact');

console.log(`Валидных участников: ${resExact.participants.length} (ожидается 3: Иван, Сергей, Анна)`);
console.log(`Исключенных: ${resExact.duplicates.length} (ожидается 2: Ольга и Павел)`);

for (const p of resExact.participants) {
  console.log(`  №${p.number} -> ${p.username}: "${p.commentText}"`);
}
for (const d of resExact.duplicates) {
  console.log(`  - ${d.username}: ${d.reason}`);
}

if (resExact.participants.length === 3 && resExact.duplicates.length === 2) {
  console.log('\n✅ ТЕСТ МНОГОСТРОЧНОГО СПИСКА УСПЕШНО ПРОЙДЕН!');
} else {
  throw new Error('Ошибка теста!');
}
