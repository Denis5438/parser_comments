import assert from 'node:assert';
import fs from 'fs';
import ExcelJS from 'exceljs';
import { deduplicator } from '../src/services/deduplicator.js';
import { excelService, sanitizeCellValue } from '../src/services/excel.js';
import { RawComment } from '../src/types.js';

async function run() {
  console.log('🧪 Запуск тестов ExcelService и защиты от Formula Injection (CWE-1236)...');

  // 1. Модульные тесты функции sanitizeCellValue
  console.log('--- Тест 1: Санитизация значений ячеек (CWE-1236 & XML 1.0) ---');
  assert.strictEqual(sanitizeCellValue('=cmd|"/c calc"!A0'), '\'=cmd|"/c calc"!A0', 'Формула с "=" должна экранироваться');
  assert.strictEqual(sanitizeCellValue('+12345'), '\'+12345', 'Значение с "+" должно экранироваться');
  assert.strictEqual(sanitizeCellValue('-999'), '\'-999', 'Значение с "-" должно экранироваться');
  assert.strictEqual(sanitizeCellValue('@sum(A1:A10)'), '\'@sum(A1:A10)', 'Значение с "@" должно экранироваться');
  assert.strictEqual(sanitizeCellValue('\tcmd'), '\'\tcmd', 'Значение с табом должно экранироваться');
  assert.strictEqual(sanitizeCellValue('\rcmd'), '\'\rcmd', 'Значение с возврат каретки должно экранироваться');
  assert.strictEqual(sanitizeCellValue('Обычный текст'), 'Обычный текст', 'Безопасный текст не должен модифицироваться');
  assert.strictEqual(sanitizeCellValue(12345), 12345, 'Числа должны оставаться без изменений');
  assert.strictEqual(sanitizeCellValue(null), null, 'null должен оставаться без изменений');

  // Проверка фильтрации XML 1.0 запрещенных управляющих символов
  const withControlChars = 'Hello\x00\x08\x0B\x0C\x0E\x1F\x7FWorld';
  assert.strictEqual(sanitizeCellValue(withControlChars), 'HelloWorld', 'Управляющие символы XML 1.0 должны удаляться');
  console.log('✅ Тест 1 пройден: sanitizeCellValue корректно экранирует формулы и удаляет XML control chars');

  // 2. Тест генерации Excel с потенциально вредоносными данными
  console.log('--- Тест 2: Генерация отчета Excel с формульными инъекциями ---');
  const mockComments: RawComment[] = [
    {
      userId: 'user_1',
      username: '=cmd|"/c calc"!A0', // Вредоносный никнейм
      profileUrl: 'https://vk.com/id1',
      commentText: '+1234567890',     // Вредоносный текст с +
      createdAt: new Date('2026-11-01T10:00:00Z'),
    },
    {
      userId: 'user_2',
      username: '@admin',            // Вредоносный никнейм с @
      profileUrl: 'https://instagram.com/anna_s',
      commentText: '-2+5+cmd|calc',  // Вредоносный текст с -
      createdAt: new Date('2026-11-01T10:05:00Z'),
    },
    {
      userId: 'user_3',
      username: 'Обычный Участник',
      profileUrl: 'https://vk.com/normal',
      commentText: 'Участвую!',
      createdAt: new Date('2026-11-01T10:08:00Z'),
    },
    {
      userId: 'user_1',
      username: '=cmd|"/c calc"!A0',
      profileUrl: 'https://vk.com/id1',
      commentText: '@evil_duplicate',
      createdAt: new Date('2026-11-01T10:10:00Z'),
    },
  ];

  const result = deduplicator.processComments(mockComments, 'first_wins');
  // Передаем URL с недопустимыми символами для имени листа Excel [ \ / ? * : ]
  const filePath = await excelService.generateReport(result, 'https://vk.com/wall-123_456?filter=[all]*');
  console.log(`Файл Excel успешно создан: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    throw new Error('❌ Файл не найден после генерации!');
  }

  // 3. Читаем созданный Excel и проверяем ячейки
  console.log('--- Тест 3: Проверка ячеек сгенерированного файла Excel ---');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  // Проверка санированного имени листа (не должно содержать \ / ? * : [ ])
  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  for (const name of sheetNames) {
    assert.ok(!/[\\/?*:[\]]/.test(name), `Имя листа "${name}" содержит недопустимые символы`);
  }
  console.log(`✅ Имена листов соответствуют ограничениям Excel: ${sheetNames.join(', ')}`);

  // Проверка ячеек на Листе 1 (Участники)
  const sheet1 = workbook.worksheets[0];
  sheet1.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Пропускаем заголовок
    row.eachCell((cell) => {
      const val = typeof cell.value === 'string' ? cell.value : '';
      if (/^[=+\-@\t\r]/.test(val)) {
        throw new Error(`❌ Найдена неэкранированная формула в строке ${rowNumber}, колонка ${cell.address}: ${val}`);
      }
    });
  });

  // Проверка ячеек на Листе 2 (Исключенные)
  const sheet2 = workbook.worksheets[1];
  sheet2.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      const val = typeof cell.value === 'string' ? cell.value : '';
      if (/^[=+\-@\t\r]/.test(val)) {
        throw new Error(`❌ Найдена неэкранированная формула на Листе 2 в строке ${rowNumber}, колонка ${cell.address}: ${val}`);
      }
    });
  });

  console.log('✅ Все ячейки с опасными префиксами (=, +, -, @, \\t, \\r) успешно экранированы!');
  console.log('🎉 Все тесты ExcelService успешно пройдены!');
}

run().catch((err) => {
  console.error('❌ Ошибка в тестах Excel:', err);
  process.exit(1);
});
