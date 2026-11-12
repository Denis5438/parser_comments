import { CleanupService, startCleanupJob, stopCleanupJob, cleanupService } from '../src/services/cleanupService.js';
import fs from 'fs/promises';
import path from 'path';

async function runCleanupTests() {
  console.log('🧪 Запуск тестов CleanupService...');

  const testDir = path.resolve(process.cwd(), 'temp/test_cleanup');
  await fs.mkdir(testDir, { recursive: true });

  const now = Date.now();
  const fileFresh = path.join(testDir, 'giveaway_fresh.xlsx');
  const fileStale = path.join(testDir, 'giveaway_stale.xlsx');
  const fileStaleTmp = path.join(testDir, 'export_stale.tmp');
  const fileNonXlsx = path.join(testDir, 'notes_stale.txt');
  const dirMatchingXlsx = path.join(testDir, 'subfolder.xlsx'); // Каталог с расширением .xlsx

  // Создаем тестовые файлы и каталог
  await fs.writeFile(fileFresh, 'fresh data');
  await fs.writeFile(fileStale, 'stale data');
  await fs.writeFile(fileStaleTmp, 'stale tmp data');
  await fs.writeFile(fileNonXlsx, 'do not delete');
  await fs.mkdir(dirMatchingXlsx, { recursive: true });

  // Устанавливаем время модификации для устаревших файлов и папки (2 часа назад)
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
  await fs.utimes(fileStale, twoHoursAgo, twoHoursAgo);
  await fs.utimes(fileStaleTmp, twoHoursAgo, twoHoursAgo);
  await fs.utimes(fileNonXlsx, twoHoursAgo, twoHoursAgo);
  await fs.utimes(dirMatchingXlsx, twoHoursAgo, twoHoursAgo);

  // 1. Тест очистки, удаления .xlsx/.tmp, пропуска подкаталогов .xlsx и дедупликации путей
  const cleaner = new CleanupService({
    directories: [testDir, testDir], // Проверка дедупликации путей
    maxAgeMs: 30 * 60 * 1000,        // 30 минут
    intervalMs: 60000,
  });

  if (cleaner.getDirectories().length !== 1) {
    throw new Error(`❌ Ошибка дедупликации директорий: ожидалась 1, получено ${cleaner.getDirectories().length}`);
  }

  const stats = await cleaner.runCleanup();

  // Проверки существования
  let staleExists = true;
  try { await fs.access(fileStale); } catch { staleExists = false; }

  let staleTmpExists = true;
  try { await fs.access(fileStaleTmp); } catch { staleTmpExists = false; }

  let freshExists = false;
  try { await fs.access(fileFresh); freshExists = true; } catch {}

  let nonXlsxExists = false;
  try { await fs.access(fileNonXlsx); nonXlsxExists = true; } catch {}

  let dirExists = false;
  try {
    const dirStat = await fs.stat(dirMatchingXlsx);
    dirExists = dirStat.isDirectory();
  } catch {}

  if (!staleExists && !staleTmpExists && freshExists && nonXlsxExists && dirExists && stats.deletedFiles === 2 && stats.errors === 0) {
    console.log('✅ Тест 1 пройден: устаревшие .xlsx и .tmp удалены, каталог subfolder.xlsx пропущен, дедупликация сработала!');
  } else {
    throw new Error(
      `❌ Ошибка проверки Теста 1: staleExists=${staleExists}, staleTmpExists=${staleTmpExists}, freshExists=${freshExists}, dirExists=${dirExists}, deleted=${stats.deletedFiles}, errors=${stats.errors}`
    );
  }

  // 2. Тест порога возраста (Age Threshold Boundary)
  const fileBoundaryYoung = path.join(testDir, 'boundary_young.xlsx');
  const fileBoundaryOld = path.join(testDir, 'boundary_old.xlsx');
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

  if (youngExists && !oldExists && stats2.deletedFiles === 1) {
    console.log('✅ Тест 2 пройден: порог возраста корректно отфильтровал файлы!');
  } else {
    throw new Error(
      `❌ Ошибка проверки Теста 2: youngExists=${youngExists}, oldExists=${oldExists}, deletedFiles=${stats2.deletedFiles}`
    );
  }

  // 3. Тест устойчивости к ошибкам (несуществующая директория)
  const nonExistentDir = path.resolve(process.cwd(), 'temp/non_existent_folder_12345');
  const resilientCleaner = new CleanupService({
    directories: [nonExistentDir],
    maxAgeMs: 60000,
    intervalMs: 60000,
  });

  const statsResilient = await resilientCleaner.runCleanup();
  if (statsResilient.errors === 0 && statsResilient.deletedFiles === 0) {
    console.log('✅ Тест 3 пройден: несуществующая директория обработана корректно без сбоев!');
  } else {
    throw new Error(`❌ Ошибка проверки Теста 3: ${JSON.stringify(statsResilient)}`);
  }

  // 4. Тест жизненного цикла (start / stop / bootstrap / shutdown)
  cleaner.start();
  // Повторный вызов start() безопасен
  cleaner.start();
  cleaner.stop();
  // Повторный вызов stop() безопасен
  cleaner.stop();

  cleaner.bootstrap();
  cleaner.shutdown();

  console.log('✅ Тест 4 пройден: жизненный цикл start/stop/bootstrap/shutdown работает корректно!');

  // Очистка тестовой папки
  await fs.rm(testDir, { recursive: true, force: true });
  console.log('🎉 Все тесты CleanupService успешно пройдены!');
}

runCleanupTests().catch((err) => {
  console.error('Ошибка в тестах cleanup:', err);
  process.exit(1);
});
