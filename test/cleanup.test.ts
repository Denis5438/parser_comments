import { CleanupService, startCleanupJob, stopCleanupJob, cleanupService } from '../src/services/cleanupService.js';
import fs from 'fs/promises';
import path from 'path';
import assert from 'node:assert';

async function runCleanupTests() {
  console.log('🧪 Запуск тестов CleanupService...');

  const testDir = path.resolve(process.cwd(), 'temp/test_cleanup');
  await fs.mkdir(testDir, { recursive: true });

  const now = Date.now();
  const fileFresh = path.join(testDir, 'giveaway_fresh.xlsx');
  const fileStaleGiveaway = path.join(testDir, 'giveaway_stale.xlsx');
  const fileStaleGiveawayTmp = path.join(testDir, 'giveaway_stale.tmp');

  // Файлы БЕЗ префикса giveaway_ (должны быть сохранены, Defect 5.4)
  const fileUserXlsx = path.join(testDir, 'important_user_report.xlsx');
  const fileUserTmp = path.join(testDir, 'export_stale.tmp');
  const fileNonXlsx = path.join(testDir, 'notes_stale.txt');
  const dirMatchingXlsx = path.join(testDir, 'giveaway_subfolder.xlsx'); // Каталог с расширением .xlsx

  // Создаем тестовые файлы и каталог
  await fs.writeFile(fileFresh, 'fresh data');
  await fs.writeFile(fileStaleGiveaway, 'stale giveaway data');
  await fs.writeFile(fileStaleGiveawayTmp, 'stale giveaway tmp data');
  await fs.writeFile(fileUserXlsx, 'user valuable data - do not delete!');
  await fs.writeFile(fileUserTmp, 'non-giveaway tmp - do not delete!');
  await fs.writeFile(fileNonXlsx, 'txt notes - do not delete!');
  await fs.mkdir(dirMatchingXlsx, { recursive: true });

  // Устанавливаем время модификации для устаревших файлов и папки (2 часа назад)
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
  await fs.utimes(fileStaleGiveaway, twoHoursAgo, twoHoursAgo);
  await fs.utimes(fileStaleGiveawayTmp, twoHoursAgo, twoHoursAgo);
  await fs.utimes(fileUserXlsx, twoHoursAgo, twoHoursAgo);
  await fs.utimes(fileUserTmp, twoHoursAgo, twoHoursAgo);
  await fs.utimes(fileNonXlsx, twoHoursAgo, twoHoursAgo);
  await fs.utimes(dirMatchingXlsx, twoHoursAgo, twoHoursAgo);

  // 1. Тест очистки: удаление ТОЛЬКО giveaway_*.xlsx и giveaway_*.tmp, защита пользовательских файлов (Defect 5.4)
  console.log('--- Тест 1: Удаление только giveaway_ файлов и защита файлов без префикса ---');
  const cleaner = new CleanupService({
    directories: [testDir, testDir], // Проверка дедупликации путей
    maxAgeMs: 30 * 60 * 1000,        // 30 минут
    intervalMs: 60000,
  });

  assert.strictEqual(cleaner.getDirectories().length, 1, 'Дедупликация путей должна оставить 1 директорию');

  const stats = await cleaner.runCleanup();

  // Проверки существования
  let staleGiveawayExists = true;
  try { await fs.access(fileStaleGiveaway); } catch { staleGiveawayExists = false; }

  let staleGiveawayTmpExists = true;
  try { await fs.access(fileStaleGiveawayTmp); } catch { staleGiveawayTmpExists = false; }

  let freshExists = false;
  try { await fs.access(fileFresh); freshExists = true; } catch {}

  let userXlsxExists = false;
  try { await fs.access(fileUserXlsx); userXlsxExists = true; } catch {}

  let userTmpExists = false;
  try { await fs.access(fileUserTmp); userTmpExists = true; } catch {}

  let nonXlsxExists = false;
  try { await fs.access(fileNonXlsx); nonXlsxExists = true; } catch {}

  let dirExists = false;
  try {
    const dirStat = await fs.stat(dirMatchingXlsx);
    dirExists = dirStat.isDirectory();
  } catch {}

  assert.strictEqual(staleGiveawayExists, false, 'giveaway_stale.xlsx должен быть удален');
  assert.strictEqual(staleGiveawayTmpExists, false, 'giveaway_stale.tmp должен быть удален');
  assert.strictEqual(freshExists, true, 'Свежий giveaway_fresh.xlsx должен сохраниться');
  assert.strictEqual(userXlsxExists, true, 'Пользовательский important_user_report.xlsx должен сохраниться');
  assert.strictEqual(userTmpExists, true, 'Пользовательский export_stale.tmp должен сохраниться');
  assert.strictEqual(nonXlsxExists, true, 'notes_stale.txt должен сохраниться');
  assert.strictEqual(dirExists, true, 'Каталог giveaway_subfolder.xlsx должен сохраниться');
  assert.strictEqual(stats.deletedFiles, 2, 'Должно быть удалено ровно 2 файла (giveaway_stale.xlsx и giveaway_stale.tmp)');
  assert.strictEqual(stats.errors, 0, 'Ошибок быть не должно');

  console.log('✅ Тест 1 пройден: удалены только файлы с префиксом giveaway_, пользовательские файлы защищены!');

  // 2. Тест порога возраста (Age Threshold Boundary)
  console.log('--- Тест 2: Порог возраста (Threshold Boundary) ---');
  const fileBoundaryYoung = path.join(testDir, 'giveaway_boundary_young.xlsx');
  const fileBoundaryOld = path.join(testDir, 'giveaway_boundary_old.xlsx');
  await fs.writeFile(fileBoundaryYoung, 'young');
  await fs.writeFile(fileBoundaryOld, 'old');

  // young: 10 минут назад (< 30 мин), old: 40 минут назад (>= 30 мин)
  const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
  const fortyMinsAgo = new Date(Date.now() - 40 * 60 * 1000);
  await fs.utimes(fileBoundaryYoung, tenMinsAgo, tenMinsAgo);
  await fs.utimes(fileBoundaryOld, fortyMinsAgo, fortyMinsAgo);

  const stats2 = await cleaner.runCleanup();

  let youngExists = false;
  try { await fs.access(fileBoundaryYoung); youngExists = true; } catch {}

  let oldExists = true;
  try { await fs.access(fileBoundaryOld); } catch { oldExists = false; }

  assert.strictEqual(youngExists, true, 'Файл моложе порога должен сохраниться');
  assert.strictEqual(oldExists, false, 'Файл старше порога должен быть удален');
  assert.strictEqual(stats2.deletedFiles, 1, 'Должен быть удален ровно 1 файл');
  console.log('✅ Тест 2 пройден: порог возраста корректно отфильтровал файлы!');

  // 3. Тест валидации конфигурации (Defect 5.6: 0, отрицательные, NaN)
  console.log('--- Тест 3: Защита конфигурации (Defect 5.6) ---');
  const invalidConfigCleaner = new CleanupService({
    maxAgeMs: -100,
    intervalMs: 0,
  });
  // Проверяем, что невалидные значения заменились на безопасные дефолты (30m и 15m)
  assert.ok((invalidConfigCleaner as any).maxAgeMs > 0, 'maxAgeMs должен быть положительным');
  assert.ok((invalidConfigCleaner as any).intervalMs > 0, 'intervalMs должен быть положительным');

  const nanConfigCleaner = new CleanupService({
    maxAgeMs: NaN,
    intervalMs: NaN,
  });
  assert.strictEqual((nanConfigCleaner as any).maxAgeMs, 30 * 60 * 1000, 'NaN maxAgeMs должен сбрасываться в 30м');
  assert.strictEqual((nanConfigCleaner as any).intervalMs, 15 * 60 * 1000, 'NaN intervalMs должен сбрасываться в 15м');
  console.log('✅ Тест 3 пройден: некорректные параметры конфигурации безопасно нормализуются');

  // 4. Тест устойчивости к ошибкам (несуществующая директория)
  console.log('--- Тест 4: Устойчивость к несуществующим директориям ---');
  const nonExistentDir = path.resolve(process.cwd(), 'temp/non_existent_folder_12345');
  const resilientCleaner = new CleanupService({
    directories: [nonExistentDir],
    maxAgeMs: 60000,
    intervalMs: 60000,
  });

  const statsResilient = await resilientCleaner.runCleanup();
  assert.strictEqual(statsResilient.errors, 0);
  assert.strictEqual(statsResilient.deletedFiles, 0);
  console.log('✅ Тест 4 пройден: несуществующая директория обработана без сбоев!');

  // 5. Тест жизненного цикла (start / stop / bootstrap / shutdown)
  console.log('--- Тест 5: Жизненный цикл службы ---');
  cleaner.start();
  cleaner.start(); // Повторный вызов безопасен
  cleaner.stop();
  cleaner.stop();  // Повторный вызов безопасен

  cleaner.bootstrap();
  cleaner.shutdown();
  console.log('✅ Тест 5 пройден: жизненный цикл start/stop/bootstrap/shutdown работает корректно!');

  // Очистка тестовой папки
  await fs.rm(testDir, { recursive: true, force: true });
  console.log('\n🎉 Все тесты CleanupService успешно пройдены!');
}

runCleanupTests().catch((err) => {
  console.error('❌ Ошибка в тестах cleanup:', err);
  process.exit(1);
});
