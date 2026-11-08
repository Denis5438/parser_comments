import { deduplicator } from '../src/services/deduplicator.js';
import { excelService } from '../src/services/excel.js';
import { RawComment } from '../src/types.js';
import fs from 'fs';

const mockComments: RawComment[] = [
  {
    userId: 'user_1',
    username: 'Иван Иванов',
    profileUrl: 'https://vk.com/id1',
    commentText: 'Участвую в розыгрыше!',
    createdAt: new Date('2026-11-01T10:00:00Z'),
  },
  {
    userId: 'user_2',
    username: 'Анна Смирнова',
    profileUrl: 'https://instagram.com/anna_s',
    commentText: 'Классный приз! Хочу победить',
    createdAt: new Date('2026-11-01T10:05:00Z'),
  },
  {
    userId: 'user_1',
    username: 'Иван Иванов',
    profileUrl: 'https://vk.com/id1',
    commentText: 'Спам-комментарий номер 2',
    createdAt: new Date('2026-11-01T10:10:00Z'),
  },
];

async function run() {
  console.log('Тестирование генерации Excel...');
  const result = deduplicator.processComments(mockComments, 'first_wins');
  const filePath = await excelService.generateReport(result, 'https://vk.com/wall-123_456');
  console.log(`Файл Excel успешно создан: ${filePath}`);
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    console.log(`Размер файла: ${stats.size} байт. Тест пройден успешно!`);
  } else {
    throw new Error('Файл не найден после генерации!');
  }
}

run().catch(console.error);
