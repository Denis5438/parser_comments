import { createBot } from './bot.js';
import { validateConfig, config } from './config.js';
import { startHealthServer, stopHealthServer } from './services/healthServer.js';
import { startCleanupJob, stopCleanupJob } from './services/cleanupService.js';

async function bootstrap() {
  console.log('--------------------------------------------------');
  console.log('🚀 Запуск бота для розыгрышей (Giveaway Contest Bot)...');
  console.log('--------------------------------------------------');

  const { valid, missing } = validateConfig();
  if (!valid) {
    console.error('❌ Ошибка запуска: отсутствуют обязательные переменные:');
    for (const key of missing) {
      console.error(`  - ${key}`);
    }
    console.error('\nУкажите их в файле .env (см. пример в .env.example)');
    process.exit(1);
  }

  // Запуск HTTP health-сервера (нужен для Render + UptimeRobot).
  // Стартует до bot.start(), чтобы Render сразу получил бинд на порт.
  const healthServer = startHealthServer(config.port);

  // Запуск службы автоматической периодической очистки Excel-файлов
  startCleanupJob();

  const bot = createBot();

  // Обработка мягкой остановки процесса (graceful shutdown)
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\nПолучен сигнал ${signal}. Остановка бота...`);
    try {
      stopCleanupJob();
      await stopHealthServer(healthServer);
      await bot.stop();
      console.log('Бот успешно остановлен.');
      process.exit(0);
    } catch (err) {
      console.error('Ошибка при остановке бота:', err);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  console.log('✅ Telegram бот инициализирован. Запуск long polling...');
  await bot.start({
    onStart: (botInfo) => {
      console.log(`🤖 Бот @${botInfo.username} успешно запущен и готов к работе!`);
    },
  });
}

bootstrap().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
