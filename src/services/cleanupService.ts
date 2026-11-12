import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

export interface CleanupStats {
  scannedFiles: number;
  deletedFiles: number;
  reclaimedBytes: number;
  errors: number;
}

export interface CleanupOptions {
  directories: string[];
  maxAgeMs: number;
  intervalMs: number;
}

export class CleanupService {
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private readonly directories: string[];
  private readonly maxAgeMs: number;
  private readonly intervalMs: number;

  constructor(options?: Partial<CleanupOptions>) {
    // Дедупликация путей директорий на случай перекрытия или дублирования конфигурации
    this.directories = Array.from(
      new Set(
        options?.directories || [
          config.downloadsDir,
          config.legacyOutputDir,
        ]
      )
    );
    this.maxAgeMs = options?.maxAgeMs ?? config.excelMaxAgeMinutes * 60 * 1000;
    this.intervalMs = options?.intervalMs ?? config.cleanupIntervalMinutes * 60 * 1000;
  }

  /**
   * Возвращает список директорий, за которыми следит служба.
   */
  public getDirectories(): string[] {
    return [...this.directories];
  }

  /**
   * Запускает периодическую очистку по таймеру и выполняет немедленный первичный прогон.
   */
  public start(): void {
    if (this.timer) {
      return;
    }

    console.log(
      `[CleanupService] Служба автоочистки запущена. Интервал: ${Math.round(
        this.intervalMs / 60000
      )} мин, порог возраста: ${Math.round(this.maxAgeMs / 60000)} мин.`
    );

    // Первичная очистка на старте
    this.runCleanup().catch((err) => {
      console.error('[CleanupService] Ошибка первичной очистки при старте:', err);
    });

    this.timer = setInterval(() => {
      this.runCleanup().catch((err) => {
        console.error('[CleanupService] Ошибка периодической очистки:', err);
      });
    }, this.intervalMs);

    // unref() чтобы таймер не блокировал завершение процесса
    this.timer.unref();
  }

  /**
   * Алиас для запуска при инициализации приложения
   */
  public bootstrap(): void {
    this.start();
  }

  /**
   * Останавливает таймер периодической очистки.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[CleanupService] Служба автоочистки остановлена.');
    }
  }

  /**
   * Алиас для остановки при graceful shutdown
   */
  public shutdown(): void {
    this.stop();
  }

  /**
   * Выполняет сканирование директорий и удаление устаревших Excel-файлов.
   */
  public async runCleanup(): Promise<CleanupStats> {
    if (this.isRunning) {
      console.log('[CleanupService] Предыдущий цикл очистки еще выполняется, пропуск.');
      return { scannedFiles: 0, deletedFiles: 0, reclaimedBytes: 0, errors: 0 };
    }

    this.isRunning = true;
    const stats: CleanupStats = {
      scannedFiles: 0,
      deletedFiles: 0,
      reclaimedBytes: 0,
      errors: 0,
    };

    const now = Date.now();

    try {
      for (const dir of this.directories) {
        try {
          await fs.access(dir);
        } catch {
          // Директория еще не создана — это штатная ситуация
          continue;
        }

        let entries: string[];
        try {
          entries = await fs.readdir(dir);
        } catch (err: any) {
          console.warn(`[CleanupService] Не удалось прочитать директорию ${dir}: ${err.message}`);
          stats.errors++;
          continue;
        }

        for (const file of entries) {
          // Удаляем только Excel-файлы и временные выгрузки
          if (!file.toLowerCase().endsWith('.xlsx') && !file.toLowerCase().endsWith('.tmp')) {
            continue;
          }

          stats.scannedFiles++;
          const fullPath = path.join(dir, file);

          try {
            const fileStat = await fs.stat(fullPath);

            // Пропускаем директории (например, подкаталог с именем test.xlsx или temp.tmp)
            if (!fileStat.isFile()) {
              continue;
            }

            const fileAgeMs = now - fileStat.mtimeMs;

            if (fileAgeMs >= this.maxAgeMs) {
              const fileSize = fileStat.size;
              await fs.unlink(fullPath);
              stats.deletedFiles++;
              stats.reclaimedBytes += fileSize;
              console.log(
                `[CleanupService] Удален устаревший файл: ${file} (возраст: ${Math.round(
                  fileAgeMs / 60000
                )} мин, размер: ${Math.round(fileSize / 1024)} КБ)`
              );
            }
          } catch (err: any) {
            // Игнорируем если файл уже удален (ENOENT)
            if (err.code === 'ENOENT') {
              continue;
            }
            // Файл занят другим процессом (EBUSY / EPERM)
            if (err.code === 'EBUSY' || err.code === 'EPERM') {
              console.warn(
                `[CleanupService] Файл ${file} заблокирован или используется другим процессом. Пропуск.`
              );
              stats.errors++;
              continue;
            }
            console.error(`[CleanupService] Ошибка при удалении файла ${fullPath}:`, err.message);
            stats.errors++;
          }
        }
      }

      if (stats.deletedFiles > 0) {
        console.log(
          `[CleanupService] Очистка завершена: удалено ${stats.deletedFiles} файлов, освобождено ${(
            stats.reclaimedBytes /
            (1024 * 1024)
          ).toFixed(2)} МБ.`
        );
      }
    } finally {
      this.isRunning = false;
    }

    return stats;
  }
}

export const cleanupService = new CleanupService();

export function startCleanupJob(): void {
  cleanupService.start();
}

export function stopCleanupJob(): void {
  cleanupService.stop();
}

export function bootstrap(): void {
  cleanupService.bootstrap();
}

export function shutdown(): void {
  cleanupService.shutdown();
}
