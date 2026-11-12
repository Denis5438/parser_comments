# Technical Implementation Plan: Disk Auto-Cleanup & VK API Rate-Limiter Protection

**Document Version:** 1.1.0 (Hardened Architecture — Iteration 2 Remediation)  
**Target System:** Telegram Giveaway Contest Bot (`giveaway-contest-bot`)  
**Runtime Environment:** Node.js 20+ LTS (ESM), TypeScript 5.7.3, Render Cloud Web Service  
**Date:** November 2026  
**Status:** Ready for Review (No existing codebase files modified)

---

## 1. Executive Summary & Problem Statement

This technical implementation plan addresses two critical production resilience vulnerabilities in the Telegram Giveaway Contest Bot:

1. **Uncontrolled Disk Overflow on Render** due to unpurged `.xlsx` report files accumulated across persistent container lifecycles.
2. **VK API Rate Limiting Failures (Error Code 6)** caused by unshared VK client instances, tight unthrottled comment pagination loops, missing concurrency serialization (`maxConcurrent: 1`), and lack of a process-wide circuit breaker on Error 6.

### 1.1 Root Cause Analysis: Disk Overflow on Render

Render web services operate on an **ephemeral root filesystem**. While ephemeral disks are wiped when a service restarts or redeploys, production instances running keepalive pingers do not restart for weeks or months:

- **The Keepalive Trap:** The application exposes an HTTP server in `src/services/healthServer.ts` listening on `PORT` with `/ping` and `/health` endpoints. Uptime monitoring services (e.g., UptimeRobot, cron-job.org) send requests every 5–15 minutes to prevent the free/starter tier container from idling. As a consequence, the container stays active continuously.
- **The Storage Leak:** Every giveaway executed generates a rich Excel workbook via `ExcelService.generateReport()` (`src/services/excel.ts:169-178`). Workbook generation formats two worksheets (numbered participants and filtered duplicates) and writes them to disk using `workbook.xlsx.writeFile(filePath)`.
- **Zero Cleanup Mechanism:** There is **no file deletion logic anywhere in the codebase** (`fs.unlink`, `fs.rm`, scheduled cron, or garbage collection are absent). The current workspace already holds 34+ legacy `.xlsx` files totaling hundreds of kilobytes from prior operations.
- **The Failure Mode:** Under active giveaway usage (files with 5,000–50,000 participant rows measuring 1–10 MB each), Render's disk quota is quickly exhausted. Once the quota is breached, `workbook.xlsx.writeFile` throws `ENOSPC: no space left on device`, permanently crashing report generation and failing all active bot requests.
- **Path Discrepancy Reconciliation:** The project prompt references purging files from `/temp/downloads`, whereas the current codebase hardcodes output generation to `path.resolve(process.cwd(), 'output')`. Both `temp/` and `output/` are ignored in `.gitignore`. The solution reconciles this discrepancy by configuring storage paths centrally, migrating write operations, deduplicating scanned directory paths (`Set`), verifying `fileStat.isFile()` before unlinking, and ensuring the cleanup task purges both directories so no legacy files remain orphaned.

### 1.2 Root Cause Analysis: VK API Rate Limiting (Error 6)

When scraping comments from VK posts and videos (`src/services/vk.ts`), large giveaways frequently crash with VK API rate limit exceptions:

- **Unshared VK Client Instances:** In `src/services/vk.ts:60-62`, `const vk = new VK({ token: config.vkServiceToken })` is instantiated **inside** `fetchComments()` on every call. Each scrape execution creates an isolated `VK` client instance with an independent, unshared `SequentialWorker`. When multiple Telegram users trigger scrapes concurrently, their requests run simultaneously without coordination, easily violating the global token rate limit.
- **VK API Service Token Quota:** VK API enforces a hard ceiling of **3 requests per second** for application service tokens (`VK_SERVICE_TOKEN`).
- **Tight Unthrottled Pagination Loop:** In `src/services/vk.ts:69-168`, `fetchComments()` executes a tight `while (offset < totalCount)` loop, requesting 100 comments per iteration without inter-request delays. Fetching 3,000 comments fires 30 requests back-to-back in less than 2 seconds; fetching 10,000 comments fires 100 requests.
- **Error Spectrum:**
  - **VK Error 6 (`TOO_MANY` - "Too many requests per second"):** Triggered immediately when request velocity exceeds 3 req/sec.
  - **VK Error 9 (`FLOOD` - "Flood control"):** Triggered when identical scraping patterns or rapid calls are flagged by VK anti-spam.
  - **VK Error 10 (`INTERNAL_ERROR`):** Transient VK database or internal server errors during peak hours.
  - **VK Error 29 (`RATE_LIMIT`):** Daily or monthly quota exhaustion.
- **Lack of Retry and Backoff:** `src/services/vk.ts` contains no `try/catch` around `vk.api.wall.getComments` or `vk.api.video.getComments`. Any rate limit or network glitch immediately rejects the promise, bubbles up to `src/bot.ts:541-549`, and sends a failure message (`❌ Произошла ошибка`) to the Telegram user, aborting the giveaway.
- **Double-Click Race Condition (TOCTOU):** `src/bot.ts` lacked a synchronous session lock. A user double-clicking "Начать сбор" could trigger duplicate concurrent scraping loops before the bot yielded to the event loop.
- **Lack of Global Queue Pause on Error 6:** When Error 6 occurs, sleeping only inside the individual failed promise allows other queued requests to continue firing and failing, exhausting retry budgets prematurely. A process-wide circuit breaker (`pausedUntil`) is required.

---

## 2. Repository Context & Architectural Baseline

### 2.1 Technology Stack & Modules

- **Runtime:** Node.js 20+ LTS with native ECMAScript Modules (`"type": "module"` in `package.json`).
- **Language & Compiler:** TypeScript 5.7.3 (`tsconfig.json`: `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `strict: true`, `rootDir: "./src"`, `outDir: "./dist"`).
- **Core Dependencies:**
  - `grammy` (`^1.34.0`): Telegram Bot framework with polling and callback query handling.
  - `vk-io` (`^4.10.1`): VKontakte API SDK featuring `SequentialWorker` and `createCollectIterator`.
  - `exceljs` (`^4.4.0`): Streaming and buffered XLSX workbook generation.
  - `dotenv` (`^16.4.7`): Environment configuration loader.
  - `axios` (`^1.7.9`), `googleapis` (`^144.0.0`): Complementary scraper integrations (YouTube, Dzen, Instagram).
  - `tsx` (`^4.19.2`): TypeScript execution runtime for dev and testing.

### 2.2 Entry Points & Process Lifecycle

```
[Render Web Service]
        │
        ▼
   server.js  ──────────► Checks ./dist/index.js (runs tsc build if absent)
        │
        ▼
   src/index.ts (bootstrap)
        │
        ├─► 1. validateConfig() (validates TELEGRAM_BOT_TOKEN)
        ├─► 2. startHealthServer(config.port) (binds HTTP /ping, /health on PORT)
        ├─► 3. createBot() (registers grammY handlers)
        ├─► 4. Registers SIGINT / SIGTERM graceful shutdown handlers
        └─► 5. bot.start() (starts long polling)
```

### 2.3 Existing Verification Status

The existing codebase compiles cleanly and passes all test suites:
- `npm run build`: `tsc` compiles cleanly with exit code 0 to `./dist`.
- `npm test`: Runs `test/deduplication.test.ts`, `test/excel.test.ts`, and `test/health.test.ts` (with network binding permission), all passing 100%.
- **Zero Code Modification Constraint:** In accordance with the prompt constraints, existing codebase files remain 100% untouched during this planning phase.

---

## 3. Feature 1: Disk Auto-Cleanup Strategy for Excel Files

### 3.1 Storage Path Reconciliation & Standardization

To eliminate the discrepancy between the user prompt (`/temp/downloads`) and current codebase (`output/`), the implementation standardizes directory resolution:

1. **Central Configuration in `src/config.ts`:**
   - Add `downloadsDir: path.resolve(process.cwd(), process.env.DOWNLOADS_DIR || 'temp/downloads')`.
   - Add `legacyOutputDir: path.resolve(process.cwd(), 'output')`.
   - Add `excelMaxAgeMinutes: parseInt(process.env.EXCEL_MAX_AGE_MINUTES || '30', 10)`.
   - Add `cleanupIntervalMinutes: parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '15', 10)`.
2. **Excel Service Storage Update (`src/services/excel.ts`):**
   - Update `excelService.generateReport()` to save files into `config.downloadsDir` instead of hardcoded `output/`.
   - Automatically ensure directory existence via `fs.mkdir(config.downloadsDir, { recursive: true })`.
3. **Dual Directory Cleanup Scanner & Deduplication:**
   - The cleanup service will scan **both** `config.downloadsDir` and `config.legacyOutputDir`.
   - To guard against directory configuration overlaps (e.g., if `DOWNLOADS_DIR` is set to `output`), target paths are deduplicated via `Array.from(new Set(this.directories))` so no folder is scanned twice.
   - This guarantees that legacy `.xlsx` files already sitting on disk (including the 34+ files currently in `output/`) are purged on startup, reclaiming immediate storage.
4. **Git Tracking Safety:**
   - Both `temp/` and `output/` are already excluded in `.gitignore` (lines 5–6), preventing generated files from polluting git commits.

### 3.2 Age Threshold Tracking & Purge Criteria

- **Target Files:** Files matching `*.xlsx` (case-insensitive) or temporary workbook artifacts (`*.tmp`).
- **Age Calculation:**
  $$\text{Age} = \text{Date.now()} - \text{stats.mtimeMs}$$
  A file is eligible for deletion if $\text{Age} \ge \text{maxAgeMs} = \text{config.excelMaxAgeMinutes} \times 60 \times 1000$.
- **Configurable Retention Window:**
  - Default: **30 minutes** (`EXCEL_MAX_AGE_MINUTES=30`).
  - Telegram bot uploads the generated file via `ctx.replyWithDocument(new InputFile(filePath))` immediately after creation. Once received by Telegram, the document is permanently cached in Telegram's CDN and accessible to the user indefinitely.
  - A 30-minute retention window provides ample buffer for:
    - Retries in case of slow Telegram network upload.
    - User re-downloading or admin inspection if necessary.
    - Zero risk of deleting a file currently being written or sent.

### 3.3 Periodic Scheduling & Startup Sweep

- **Scheduling Mechanism:** Native Node.js `setInterval` with `.unref()`.
  - Calling `.unref()` prevents the timer from keeping the Node.js event loop artificially alive if all other tasks complete.
  - Interval: Configurable via `CLEANUP_INTERVAL_MINUTES` (default: 15 minutes).
- **Startup Sweep:**
  - Upon bot launch in `src/index.ts:bootstrap()`, `cleanupService.runCleanup()` is executed immediately.
  - This eliminates accumulated files left behind from previous process runs or test runs before the bot begins accepting new traffic.

### 3.4 Error Handling & File System Resilience

File deletion on production filesystems can encounter race conditions or locking issues:
- **`ENOENT` (File Not Found):** If a file was deleted concurrently by another process or manual command, catch and ignore without throwing.
- **`EBUSY` / `EPERM` (Resource Busy / Permission Denied):** If a file is currently open for writing by ExcelJS or being streamed by grammY, catch the error, log a warning, and allow the next scheduled sweep to clean it up.
- **Directory & Non-File Skipping (`fileStat.isFile()`):** If a directory or subdirectory matches the file extension pattern (for example, a subfolder named `backup.xlsx` or `temp.tmp`), calling `fs.unlink` causes `EISDIR` (POSIX) or `EPERM` (Windows). The service checks `if (!fileStat.isFile()) continue;` before unlinking, ensuring only genuine files are deleted.
- **Non-blocking Operations:** All I/O operations strictly use `fs.promises` (`readdir`, `stat`, `unlink`) to prevent blocking the Node.js single thread.
- **Structured Subsystem Logging:** All logs use the prefix `[CleanupService]`, recording files scanned, files deleted, bytes reclaimed, and any skipped files.

### 3.5 Graceful Shutdown Integration

- In `src/index.ts`, the graceful shutdown handler `shutdown(signal)` will call `cleanupService.stop()`.
- `cleanupService.stop()` clears the active `setInterval` handle, ensuring clean process exit during Render container rolling restarts or redeployments.

---

### 3.6 Proposed Code Snippets & File Diffs for Feature 1

#### 1. New Service: `src/services/cleanupService.ts`

```typescript
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
```

---

#### 2. Diff for `src/config.ts`

```diff
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,7 +1,12 @@
 import dotenv from 'dotenv';
+import path from 'path';
 dotenv.config();
 
 export const config = {
   telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
   youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
   vkServiceToken: process.env.VK_SERVICE_TOKEN || '',
   instagramSessionId: process.env.INSTAGRAM_SESSION_ID || '',
   port: parseInt(process.env.PORT || '3000', 10),
+  downloadsDir: path.resolve(process.cwd(), process.env.DOWNLOADS_DIR || 'temp/downloads'),
+  legacyOutputDir: path.resolve(process.cwd(), 'output'),
+  excelMaxAgeMinutes: parseInt(process.env.EXCEL_MAX_AGE_MINUTES || '30', 10),
+  cleanupIntervalMinutes: parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '15', 10),
 };
```

---

#### 3. Diff for `src/services/excel.ts`

```diff
--- a/src/services/excel.ts
+++ b/src/services/excel.ts
@@ -2,6 +2,7 @@ import ExcelJS from 'exceljs';
 import path from 'path';
 import fs from 'fs/promises';
 import { DeduplicationResult } from '../types.js';
+import { config } from '../config.js';
 
 export class ExcelService {
   /**
@@ -166,7 +167,7 @@ export class ExcelService {
       });
     }
 
-    const outputDir = path.resolve(process.cwd(), 'output');
+    const outputDir = config.downloadsDir;
     await fs.mkdir(outputDir, { recursive: true });
 
     const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
```

---

#### 4. Diff for `src/index.ts`

```diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,6 +1,7 @@
 import { createBot } from './bot.js';
 import { validateConfig, config } from './config.js';
 import { startHealthServer, stopHealthServer } from './services/healthServer.js';
+import { cleanupService } from './services/cleanupService.js';
 
 async function bootstrap() {
   console.log('--------------------------------------------------');
@@ -23,6 +24,9 @@ async function bootstrap() {
   const healthServer = startHealthServer(config.port);
 
+  // Запуск службы автоматической периодической очистки Excel-файлов
+  cleanupService.start();
+
   const bot = createBot();
 
   // Обработка мягкой остановки процесса (graceful shutdown)
@@ -32,6 +36,7 @@ async function bootstrap() {
     console.log(`\nПолучен сигнал ${signal}. Остановка бота...`);
     try {
+      cleanupService.stop();
       await stopHealthServer(healthServer);
       await bot.stop();
       console.log('Бот успешно остановлен.');
```

---

#### 5. Diff for `.env.example`

```diff
--- a/.env.example
+++ b/.env.example
@@ -13,3 +13,10 @@ INSTAGRAM_SESSION_ID=
 # 5. НЕ ОБЯЗАТЕЛЬНО: Порт для Render / UptimeRobot (по умолчанию 3000, Render задает сам)
 PORT=3000
+
+# 6. НЕ ОБЯЗАТЕЛЬНО: Автоочистка диска от Excel-файлов
+# Папка для сохранения отчетов (по умолчанию temp/downloads)
+DOWNLOADS_DIR=temp/downloads
+# Порог удаления файлов в минутах (по умолчанию 30 минут)
+EXCEL_MAX_AGE_MINUTES=30
+# Интервал проверки очистки в минутах (по умолчанию 15 минут)
+CLEANUP_INTERVAL_MINUTES=15
```

---

## 4. Feature 2: VK API Rate-Limiter & Concurrency Protection

### 4.1 Rate Limit Architecture & Error Handling Taxonomy

The VK API enforces strict request rate limits to protect server infrastructure:

| Error Code | Identifier | Description | Root Cause | Handling Strategy |
|:---|:---|:---|:---|:---|
| **6** | `TOO_MANY` | Too many requests per second | Exceeded 3 req/sec service token cap | Throttle, pause queue, exponential backoff with full jitter |
| **9** | `FLOOD` | Flood control | Rapid identical requests detected | Exponential backoff with higher multiplier (2–5s delay) |
| **10** | `INTERNAL_ERROR` | Internal server error | Transient VK server or database glitch | Immediate exponential retry (up to 5 attempts) |
| **14** | `CAPTCHA` | Captcha needed | Bot activity triggered automated captcha | Fail fast with descriptive Russian notification |
| **15** | `ACCESS_DENIED` | Access denied | Post/group is private or restricted | Fail fast; do not retry non-transient auth/permission errors |
| **29** | `RATE_LIMIT` | Rate limit reached | Daily API call quota exhausted | Abort scrape, alert user with descriptive Russian notification explaining that the daily VK limit has expired |
| **212** | `ACCESS_TO_COMMENTS_DENIED` | Post comments disabled | Target post has closed comments | Fail fast with clean user message |
| **N/A** | Network Errors | `ETIMEDOUT`, `ECONNRESET`, `502`, `504` | Transient network dropouts | Retry with exponential backoff and jitter |

### 4.2 Shared Singleton VK Client Architecture

Currently, `new VK()` is instantiated inside `fetchComments` on every scrape. This must be replaced with a shared singleton client:

```
[User A Scrape Job] ───┐
                       ├─► [Shared VkRateLimiter Queue] ──► [Shared VK Client Singleton] ──► [VK API]
[User B Scrape Job] ───┘    (Enforces <= 2.5 req/sec,             (Configured:
                             concurrency = 1,                      apiLimit: 2.5,
                             minIntervalMs = 400ms,                apiMode: 'sequential',
                             pausedUntil circuit breaker,          apiRetryLimit: 5)
                             jittered exponential retry)
```

- **Singleton Pattern:** The `VK` instance is constructed once and stored as a static or module singleton (`vkClient`).
- **Shared Connection & Limits:** All incoming scraping operations route through the same client, enabling the client library's native `SequentialWorker` and our rate-limiting queue to track aggregate token throughput accurately.

### 4.3 Request Throttler, Concurrency Serialization & Single-Token Bucket Queue

To guarantee that request frequency never exceeds the 3 req/sec threshold and eliminate concurrent micro-bursts at $t=0$:
- **Pacing Ceiling & Inter-Request Spacing:** Configure the rate limiter to a conservative **2.5 requests per second** with a strict minimum interval spacing of **400 ms** between any consecutive dispatches (`minIntervalMs = 400`).
- **Strict Concurrency Serialization (`maxConcurrent = 1`):** At most **1 active request** may be in flight to the VK API at any millisecond across the entire process. This completely prevents parallel race conditions and socket pool contention.
- **Single-Token Bucket (`bucketCapacity = 1`):**
  - Unlike a multi-token bucket (capacity 3) which allows 3 requests to fire simultaneously at $t=0$, `capacity = 1` eliminates burst-dispatching from the very first call.
  - `refillRate = 2.5 tokens/sec` (replenishes 1 token every 400 ms).
- **Active In-Flight Tracking:** `activeRequests` counter tracks pending HTTP requests. Even if tokens are available, no queued task is released until the currently executing in-flight task completes.
- **Zero-Dependency Implementation:** Implemented as a clean, self-contained TypeScript class `VkRateLimiter` (`src/services/vkRateLimiter.ts`), eliminating external npm package vulnerabilities and version mismatches.

### 4.4 Exponential Backoff, Jitter & Global Queue Circuit Breaker

When transient errors (VK Error 6, Error 9, Error 10, or network timeouts) occur, requests must be retried using exponential backoff with full jitter:

$$\text{delay} = \min\left(\text{maxDelayMs}, \text{baseDelayMs} \times 2^{\text{attempt}-1} + \text{random}(0, \text{jitterMs})\right)$$

- **Default Parameters:**
  - `baseDelayMs`: 600 ms
  - `maxDelayMs`: 12,000 ms
  - `jitterMs`: 400 ms
  - `maxAttempts`: 5
- **Retry Schedule Example:**
  - Attempt 1: $600 \times 2^0 + \text{jitter} \approx 600\text{--}1000\text{ ms}$
  - Attempt 2: $600 \times 2^1 + \text{jitter} \approx 1200\text{--}1600\text{ ms}$
  - Attempt 3: $600 \times 2^2 + \text{jitter} \approx 2400\text{--}2800\text{ ms}$
  - Attempt 4: $600 \times 2^3 + \text{jitter} \approx 4800\text{--}5200\text{ ms}$
  - Attempt 5: $600 \times 2^4 + \text{jitter} \approx 9600\text{--}10000\text{ ms}$
- **Global Queue Circuit Breaker on VK Error 6 (`pausedUntil`):**
  - VK Error 6 indicates that the application token or IP address has saturated VK's sliding-window rate limit.
  - Rather than sleeping only inside the individual failed task while other queued requests continue firing and failing, `VkRateLimiter` maintains a process-wide circuit breaker:
    $$\text{this.pausedUntil} = \max(\text{this.pausedUntil}, \text{Date.now()} + 1500)$$
  - Both `acquireToken()` and `processQueue()` actively check `Date.now() < this.pausedUntil`.
  - While paused, all request dispatches across the entire rate limiter are frozen. This halts cascading Error 6 failures and gives VK's sliding window time to reset completely.

### 4.5 Comment Pagination Architecture: Rate-Limited Sequential Pagination vs VK execute Analysis

A thorough architectural evaluation was conducted between VKScript batching via `execute` / `createCollectIterator` versus rate-limited sequential pagination via `VkRateLimiter`:

1. **Why Rate-Limited Sequential Pagination is the Selected Production Design:**
   - **Rich Data Integrity & Thread Preservation:** In VK API, `wall.getComments` returns not only top-level comments, but also nested reply threads (`thread.items`), extended user author profiles (`extended: 1`), and group author maps. Aggregating 25 pages of extended comments inside a single `execute` VKScript block quickly breaches VKScript's 5-second CPU execution timeout, internal return payload size limit (max 5 MB JSON), and array depth limits.
   - **Deterministic Rate Limiting:** Sequential calls wrapped in `VkRateLimiter` strictly obey the 2.5 req/sec cap, `maxConcurrent: 1`, and the global `pausedUntil` circuit breaker, avoiding sudden burst quotas or IP flags.
   - **Accurate Real-Time Progress in Telegram UI:** Sequential pagination allows the bot to update the Telegram progress message (`updateProgress(offset, totalCount)`) every 100 comments (e.g. "Собрано 1200 из 3500..."), providing crucial live visual feedback to users during long-running giveaways. Batching 2,500 comments at a time produces large latency gaps (10–15 seconds of silence) where users assume the bot is frozen.
   - **Service Token Security & Permissions:** The VK `execute` method is subject to elevated permission checks and anti-spam heuristics on standalone application service tokens (`VK_SERVICE_TOKEN`), frequently triggering Error 15 (Access Denied) or Error 9 (Flood Control) for server-side automated calls.
2. **Implementation Strategy:**
   - Sequential 100-comment pagination via `vkRateLimiter.execute(() => vk.api.wall.getComments(...))` is chosen as the unified, robust production standard.
   - Unused dependencies (`createCollectIterator`) are excluded from `src/services/vk.ts`, avoiding dead code and compilation overhead.

### 4.6 User Session Concurrency Guard (Synchronous TOCTOU Prevention)

To prevent Telegram users from double-clicking inline keyboard buttons or triggering concurrent scraping pipelines for the same chat:
- **The TOCTOU Vulnerability:** In Node.js, if `session.isScraping = true` is placed after an asynchronous `await` (such as `await safeAnswerCallback(ctx)` or `await ctx.reply(...)`), execution yields to the event loop during the 150–500ms network round-trip. A second callback query arriving during this window passes the guard check and launches a duplicate scrape.
- **The Synchronous Lock Solution:**
  1. Check `if (session.isScraping) { ... return; }`
  2. Set `session.isScraping = true;` **synchronously immediately** on the next line, before ANY `await` call.
  3. Wrap the subsequent asynchronous workflow (`safeAnswerCallback`, `ctx.reply`, progress updates, scraping, deduplication, Excel generation, document sending) in a `try { ... } finally { session.isScraping = false; }` block.
  4. This guarantees that any duplicate click arriving while initial messages are being sent is blocked immediately, and the lock is guaranteed to be released upon completion or any error.

```typescript
// 🔒 Synchronous lock pattern in src/bot.ts:
if (session.isScraping) {
  await safeAnswerCallback(
    ctx,
    '⚠️ Сбор комментариев уже запущен! Пожалуйста, дождитесь окончания процесса.'
  );
  return;
}

// Set lock synchronously BEFORE any await calls
session.isScraping = true;

try {
  await safeAnswerCallback(ctx);
  const statusMsg = await ctx.reply('⏳ <b>Инициализация подключения к платформе...</b>', {
    parse_mode: 'HTML',
  });
  // ... perform scraping, deduplication, report generation ...
} catch (err: any) {
  // ... format friendly error message (including VK Error 29 quota notice) ...
} finally {
  session.isScraping = false;
}
```

---

### 4.7 Proposed Code Snippets & File Diffs for Feature 2

#### 1. New Service: `src/services/vkRateLimiter.ts`

```typescript
export interface RateLimiterOptions {
  tokensPerSecond: number;
  bucketCapacity: number;
  maxConcurrent: number;
  minIntervalMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export class VkRateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private lastDispatchTime: number = 0;
  private activeRequests: number = 0;
  private pausedUntil: number = 0;
  private readonly tokensPerSecond: number;
  private readonly bucketCapacity: number;
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private queue: Array<() => void> = [];
  private isProcessingQueue: boolean = false;

  constructor(options?: Partial<RateLimiterOptions>) {
    this.tokensPerSecond = options?.tokensPerSecond ?? 2.5; // Максимум 2.5 req/sec (при лимите VK 3 req/sec)
    this.bucketCapacity = options?.bucketCapacity ?? 1;     // Емкость 1 устраняет всплески при t=0
    this.maxConcurrent = options?.maxConcurrent ?? 1;       // Строгая сериализация: не более 1 активного запроса к VK API
    this.minIntervalMs = options?.minIntervalMs ?? Math.floor(1000 / this.tokensPerSecond); // Межинтервальная пауза (400мс)
    this.maxRetries = options?.maxRetries ?? 5;
    this.baseDelayMs = options?.baseDelayMs ?? 600;
    this.maxDelayMs = options?.maxDelayMs ?? 12000;

    this.tokens = this.bucketCapacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Возвращает метку времени, до которой очередь заморожена глобальным предохранителем (Circuit Breaker).
   */
  public getPausedUntil(): number {
    return this.pausedUntil;
  }

  /**
   * Проверяет, активна ли пауза очереди после ошибки 6.
   */
  public isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  /**
   * Возвращает количество выполняющихся в данный момент запросов к VK API.
   */
  public getActiveRequests(): number {
    return this.activeRequests;
  }

  /**
   * Пополняет токены в ведре на основе прошедшего времени.
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTime) / 1000;
    const addedTokens = elapsedSeconds * this.tokensPerSecond;

    if (addedTokens > 0) {
      this.tokens = Math.min(this.bucketCapacity, this.tokens + addedTokens);
      this.lastRefillTime = now;
    }
  }

  /**
   * Ожидает доступности токена и резервирует его с соблюдением circuit breaker и сериализации.
   */
  public async acquireToken(): Promise<void> {
    const now = Date.now();
    this.refillTokens();

    const canDispatchImmediately =
      this.queue.length === 0 &&
      this.activeRequests < this.maxConcurrent &&
      now >= this.pausedUntil &&
      now - this.lastDispatchTime >= this.minIntervalMs &&
      this.tokens >= 1;

    if (canDispatchImmediately) {
      this.tokens -= 1;
      this.lastDispatchTime = now;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    const checkInterval = 50;
    const timer = setInterval(() => {
      const now = Date.now();

      // Глобальный circuit breaker: если активна пауза, не диспатчим задачи
      if (now < this.pausedUntil) {
        return;
      }

      // Проверка максимальной параллельности (maxConcurrent: 1)
      if (this.activeRequests >= this.maxConcurrent) {
        return;
      }

      // Проверка межинтервальной паузы (minIntervalMs: 400ms)
      if (now - this.lastDispatchTime < this.minIntervalMs) {
        return;
      }

      this.refillTokens();

      if (this.tokens >= 1 && this.queue.length > 0) {
        this.tokens -= 1;
        this.lastDispatchTime = now;
        const next = this.queue.shift();
        if (next) {
          next();
        }
      }

      if (this.queue.length === 0) {
        clearInterval(timer);
        this.isProcessingQueue = false;
      }
    }, checkInterval);

    timer.unref();
  }

  /**
   * Проверяет, является ли ошибка VK или сети повторимой (retryable).
   */
  public isRetryableError(error: any): boolean {
    if (!error) return false;

    // Ошибки VK API
    const code = error.code || error.error_code;
    if (code === 6 || code === 'TOO_MANY') return true; // Слишком много запросов в секунду
    if (code === 9 || code === 'FLOOD') return true;    // Flood control
    if (code === 10 || code === 'INTERNAL_ERROR') return true; // Внутренняя ошибка сервера VK

    // Ошибки сети / таймауты
    const message = (error.message || '').toLowerCase();
    if (
      message.includes('etimedout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('socket hang up') ||
      message.includes('network error') ||
      message.includes('gateway timeout') ||
      message.includes('bad gateway')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Выполняет асинхронную операцию через рейт-лимитер с сериализацией, circuit breaker и экспоненциальным бэкоффом.
   */
  public async execute<T>(fn: () => Promise<T>, taskName: string = 'VK API Request'): Promise<T> {
    let attempt = 0;

    while (true) {
      await this.acquireToken();
      this.activeRequests++;

      try {
        return await fn();
      } catch (error: any) {
        attempt++;

        const code = error.code || error.error_code;

        // Глобальный circuit breaker: при ошибке 6 (TOO_MANY) замораживаем всю очередь на 1500мс
        if (code === 6 || code === 'TOO_MANY') {
          this.pausedUntil = Math.max(this.pausedUntil, Date.now() + 1500);
          console.warn(
            `[VkRateLimiter] Получена ошибка 6 (TOO_MANY) в "${taskName}". Очередь глобально заморожена на 1500мс.`
          );
        }

        if (attempt > this.maxRetries || !this.isRetryableError(error)) {
          console.error(
            `[VkRateLimiter] Задача "${taskName}" прервана (попытка ${attempt}/${this.maxRetries}). Ошибка:`,
            error.message || error
          );
          throw error;
        }

        // Экспоненциальный бэкофф с полным джиттером: delay = min(maxDelay, baseDelay * 2^(attempt-1) + jitter)
        const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 400);
        const totalDelay = Math.min(this.maxDelayMs, exponentialDelay + jitter);

        // При ошибке 6 добавляем локальное ожидание
        const extraWait = code === 6 || code === 'TOO_MANY' ? 1000 : 0;
        const actualWait = totalDelay + extraWait;

        console.warn(
          `[VkRateLimiter] Перехвачена ошибка ${code || error.message} в "${taskName}". Повтор ${attempt}/${this.maxRetries} через ${actualWait}мс...`
        );

        await new Promise((resolve) => setTimeout(resolve, actualWait));
      } finally {
        this.activeRequests--;
        this.processQueue();
      }
    }
  }
}

export const vkRateLimiter = new VkRateLimiter();
```

---

#### 2. Diff for `src/services/vk.ts`

```diff
--- a/src/services/vk.ts
+++ b/src/services/vk.ts
@@ -1,8 +1,24 @@
-import { VK } from 'vk-io';
+import { VK } from 'vk-io';
 import { RawComment, ScrapingOptions } from '../types.js';
 import { config } from '../config.js';
+import { vkRateLimiter } from './vkRateLimiter.js';
+
+// Shared singleton VK client
+let sharedVkClient: VK | null = null;
+function getVkClient(): VK {
+  if (!sharedVkClient) {
+    sharedVkClient = new VK({
+      token: config.vkServiceToken,
+      apiLimit: 2.5,
+      apiMode: 'sequential',
+      apiRequestMode: 'sequential',
+      apiRetryLimit: 5,
+      apiWait: 2000,
+    });
+  }
+  return sharedVkClient;
+}
 
 export class VkScraper {
   /**
@@ -58,9 +74,7 @@ export class VkScraper {
       );
     }
 
-    const vk = new VK({
-      token: config.vkServiceToken,
-    });
+    const vk = getVkClient();
 
     const comments: RawComment[] = [];
     let offset = 0;
@@ -69,15 +83,18 @@ export class VkScraper {
 
     while (offset < totalCount) {
       if (target.type === 'wall') {
-        const response = await vk.api.wall.getComments({
-          owner_id: target.ownerId,
-          post_id: target.itemId,
-          offset,
-          count,
-          extended: 1,
-          fields: ['screen_name', 'first_name', 'last_name'],
-          need_likes: 0,
-        });
+        const response = await vkRateLimiter.execute(
+          () =>
+            vk.api.wall.getComments({
+              owner_id: target.ownerId,
+              post_id: target.itemId,
+              offset,
+              count,
+              extended: 1,
+              fields: ['screen_name', 'first_name', 'last_name'],
+              need_likes: 0,
+            }),
+          `wall.getComments (offset ${offset})`
+        );
 
         totalCount = response.count;
@@ -128,14 +145,17 @@ export class VkScraper {
       } else {
         // target.type === 'video'
-        const response = await vk.api.video.getComments({
-          owner_id: target.ownerId,
-          video_id: target.itemId,
-          offset,
-          count,
-          extended: 1,
-          need_likes: 0,
-        });
+        const response = await vkRateLimiter.execute(
+          () =>
+            vk.api.video.getComments({
+              owner_id: target.ownerId,
+              video_id: target.itemId,
+              offset,
+              count,
+              extended: 1,
+              need_likes: 0,
+            }),
+          `video.getComments (offset ${offset})`
+        );
 
         totalCount = response.count;
```

---

#### 3. Diff for `src/bot.ts`

```diff
--- a/src/bot.ts
+++ b/src/bot.ts
@@ -25,6 +25,7 @@ interface UserSession {
   awaitingKeywordInput?: boolean;
   lastResult?: DeduplicationResult;
   lastReportPath?: string;
+  isScraping?: boolean;
 }
 
 const sessions = new Map<number, UserSession>();
@@ -404,11 +405,20 @@ export function createBot(): Bot {
       return;
     }
 
+    if (session.isScraping) {
+      await safeAnswerCallback(
+        ctx,
+        '⚠️ Сбор комментариев уже запущен! Пожалуйста, дождитесь окончания процесса.'
+      );
+      return;
+    }
+
+    // 🔒 Синхронная установка блокировки сессии ДО любых асинхронных вызовов (устранение TOCTOU)
+    session.isScraping = true;
+
+    try {
       await safeAnswerCallback(ctx);
 
       const statusMsg = await ctx.reply('⏳ <b>Инициализация подключения к платформе...</b>', {
@@ -427,7 +437,6 @@ export function createBot(): Bot {
     };
 
-    try {
       let rawComments: RawComment[] = [];
 
       console.log(`[BOT] Старт сбора: URL=${session.url}, платформа=${session.platform}`);
@@ -548,7 +557,21 @@ export function createBot(): Bot {
+      const errorCode = (err as any)?.code || (err as any)?.error_code;
+      let errorMessage = '❌ Произошла ошибка при сборе данных. Попробуйте позже или проверьте ссылку.';
+
+      if (errorCode === 29 || errorCode === 'RATE_LIMIT' || err?.message?.includes('Rate limit reached')) {
+        errorMessage = '⚠️ <b>Лимит запросов к VK API исчерпан</b> на сегодня. Платформа VK временно ограничивает выгрузку. Пожалуйста, повторите сбор завтра.';
+      } else if (errorCode === 15 || errorCode === 'ACCESS_DENIED') {
+        errorMessage = '🔒 <b>Ошибка доступа</b>: запись или сообщество закрыто, либо доступ к комментариям ограничен.';
+      } else if (errorCode === 212 || errorCode === 'ACCESS_TO_COMMENTS_DENIED') {
+        errorMessage = '🚫 <b>Комментарии отключены</b> автором к этой публикации.';
+      } else if (err?.message) {
+        errorMessage += `\n\n<i>Детали: ${err.message}</i>`;
+      }
+
       await ctx.reply(
-        '❌ Произошла ошибка при сборе данных. Попробуйте позже или проверьте ссылку.\n\n' +
-          `<i>Детали: ${err.message}</i>`,
+        errorMessage,
         { parse_mode: 'HTML' }
       );
+    } finally {
+      session.isScraping = false;
     }
   });
```

---

## 5. Implementation Roadmap & Step-by-Step Execution Plan

The execution is structured into 6 sequential phases designed for zero regression and full traceability:

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Configuration & Environment Setup             │
│ - Update src/config.ts & .env.example                  │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 2: Excel Auto-Cleanup Service                    │
│ - Create src/services/cleanupService.ts                │
│ - Update src/services/excel.ts to use config path      │
│ - Hook into src/index.ts (bootstrap & shutdown)        │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 3: VK Rate Limiter & Resilience Implementation   │
│ - Create src/services/vkRateLimiter.ts                 │
│ - Update src/services/vk.ts (singleton client & queue) │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 4: Bot Concurrency Protection                    │
│ - Add isScraping lock & guard in src/bot.ts            │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 5: Verification & Comprehensive Test Suites      │
│ - Create test/cleanup.test.ts                          │
│ - Create test/vkRateLimiter.test.ts                    │
│ - Update package.json test script                      │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 6: Final Audit & Production Readiness            │
│ - Run full build (npm run build) & test suite          │
│ - Deploy & verify on Render container                  │
└────────────────────────────────────────────────────────┘
```

### Detailed Phase Tasks

- **Phase 1: Configuration & Environment Setup**
  1. Add `downloadsDir`, `legacyOutputDir`, `excelMaxAgeMinutes`, and `cleanupIntervalMinutes` to `src/config.ts`.
  2. Document the new optional variables in `.env.example`.
- **Phase 2: Excel Auto-Cleanup Service**
  1. Author `src/services/cleanupService.ts` with directory deduplication (`Set`), directory safety check (`fileStat.isFile()`), `mtimeMs` threshold checking, and error resilience.
  2. Update `src/services/excel.ts` to output files to `config.downloadsDir`.
  3. Wire `cleanupService.start()` into `src/index.ts:bootstrap()` and `cleanupService.stop()` into `src/index.ts:shutdown()`.
- **Phase 3: VK API Rate Limiter & Shared Client**
  1. Author `src/services/vkRateLimiter.ts` with Token Bucket algorithm, concurrency serialization (`maxConcurrent: 1`), inter-request spacing (`minIntervalMs: 400ms`), global `pausedUntil` circuit breaker on Error 6, and exponential backoff retry.
  2. Refactor `src/services/vk.ts` to use `getVkClient()` singleton and wrap sequential API calls in `vkRateLimiter.execute()`. Exclude unused `createCollectIterator` import.
- **Phase 4: Bot Concurrency Protection**
  1. Add `isScraping` flag to `UserSession` interface in `src/bot.ts`.
  2. Implement synchronous session locking (`session.isScraping = true;`) immediately after check before any `await` calls, eliminating TOCTOU double-click race condition.
  3. Add dedicated user-friendly Russian message for VK Error 29 (daily quota reached) and guarantee lock release in `finally` block.
- **Phase 5: Verification & Testing**
  1. Implement `test/cleanup.test.ts` verifying file age calculation, deletion, `fileStat.isFile()` directory skipping, and directory deduplication.
  2. Implement `test/vkRateLimiter.test.ts` verifying request pacing, concurrency serialization (`maxConcurrent: 1`), global queue circuit breaker (`pausedUntil`) on Error 6, and non-retryable error fast-fail.
  3. Register new test suites in `package.json:scripts:test`.
- **Phase 6: Final Audit**
  1. Verify zero TypeScript errors via `npm run build`.
  2. Run all unit and integration tests via `npm test`.

---

## 6. Comprehensive Testing & Verification Strategy

### 6.1 Unit Test Suite 1: Disk Auto-Cleanup (`test/cleanup.test.ts`)

Create `test/cleanup.test.ts` to test the cleanup service thoroughly:

```typescript
import { CleanupService } from '../src/services/cleanupService.js';
import fs from 'fs/promises';
import path from 'path';

async function runCleanupTests() {
  console.log('🧪 Запуск тестов CleanupService...');

  const testDir = path.resolve(process.cwd(), 'temp/test_cleanup');
  await fs.mkdir(testDir, { recursive: true });

  const now = Date.now();
  const fileFresh = path.join(testDir, 'giveaway_fresh.xlsx');
  const fileStale = path.join(testDir, 'giveaway_stale.xlsx');
  const fileNonXlsx = path.join(testDir, 'notes_stale.txt');
  const dirMatchingXlsx = path.join(testDir, 'subfolder.xlsx'); // Каталог с расширением .xlsx

  // Создаем тестовые файлы и каталог
  await fs.writeFile(fileFresh, 'fresh data');
  await fs.writeFile(fileStale, 'stale data');
  await fs.writeFile(fileNonXlsx, 'do not delete');
  await fs.mkdir(dirMatchingXlsx, { recursive: true });

  // Устанавливаем время модификации для устаревших файлов и папки (2 часа назад)
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
  await fs.utimes(fileStale, twoHoursAgo, twoHoursAgo);
  await fs.utimes(fileNonXlsx, twoHoursAgo, twoHoursAgo);
  await fs.utimes(dirMatchingXlsx, twoHoursAgo, twoHoursAgo);

  // 1. Тест очистки и пропуска подкаталогов с расширением .xlsx, а также дедупликации путей
  const cleaner = new CleanupService({
    directories: [testDir, testDir], // Проверка дедупликации путей
    maxAgeMs: 30 * 60 * 1000,        // 30 минут
    intervalMs: 60000,
  });

  const stats = await cleaner.runCleanup();

  // Проверки
  let staleExists = true;
  try { await fs.access(fileStale); } catch { staleExists = false; }

  let freshExists = false;
  try { await fs.access(fileFresh); freshExists = true; } catch {}

  let nonXlsxExists = false;
  try { await fs.access(fileNonXlsx); nonXlsxExists = true; } catch {}

  let dirExists = false;
  try {
    const dirStat = await fs.stat(dirMatchingXlsx);
    dirExists = dirStat.isDirectory();
  } catch {}

  if (!staleExists && freshExists && nonXlsxExists && dirExists && stats.deletedFiles === 1 && stats.errors === 0) {
    console.log('✅ Тест очистки пройден: устаревший .xlsx удален, каталог subfolder.xlsx пропущен, дедупликация сработала!');
  } else {
    throw new Error(
      `❌ Ошибка проверки: staleExists=${staleExists}, freshExists=${freshExists}, dirExists=${dirExists}, deleted=${stats.deletedFiles}, errors=${stats.errors}`
    );
  }

  // Очистка тестовой папки
  await fs.rm(testDir, { recursive: true, force: true });
}

runCleanupTests().catch((err) => {
  console.error('Ошибка в тестах cleanup:', err);
  process.exit(1);
});
```

### 6.2 Unit Test Suite 2: VK Rate Limiter & Concurrency Protection (`test/vkRateLimiter.test.ts`)

Create `test/vkRateLimiter.test.ts` to test token pacing, strict serialization, and global circuit breaker:

```typescript
import { VkRateLimiter } from '../src/services/vkRateLimiter.js';

async function runRateLimiterTests() {
  console.log('🧪 Запуск тестов VkRateLimiter...');

  // 1. Тест ограничения темпа и строгой сериализации (maxConcurrent: 1)
  let activeInFlight = 0;
  let maxObservedConcurrency = 0;

  const limiter = new VkRateLimiter({
    tokensPerSecond: 5, // 5 req/sec -> minIntervalMs: 200ms
    bucketCapacity: 1,
    maxConcurrent: 1,
    minIntervalMs: 200,
    baseDelayMs: 50,
    maxDelayMs: 300,
  });

  const startTime = Date.now();
  const tasks = [0, 1, 2, 3].map((i) =>
    limiter.execute(async () => {
      activeInFlight++;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, activeInFlight);
      await new Promise((r) => setTimeout(r, 50));
      activeInFlight--;
      return i;
    }, `serial_task_${i}`)
  );

  const results = await Promise.all(tasks);
  const duration = Date.now() - startTime;

  if (maxObservedConcurrency === 1 && duration >= 600 && results.length === 4) {
    console.log(`✅ Тест сериализации и темпа пройден: maxConcurrency=1, длительность ${duration}мс (ожидалось >= 600мс)`);
  } else {
    throw new Error(
      `❌ Тест сериализации провален: maxObservedConcurrency=${maxObservedConcurrency}, duration=${duration}мс`
    );
  }

  // 2. Тест глобального предохранителя (Circuit Breaker) на ошибку 6 (TOO_MANY)
  const circuitLimiter = new VkRateLimiter({
    tokensPerSecond: 10,
    bucketCapacity: 1,
    maxConcurrent: 1,
    minIntervalMs: 50,
    baseDelayMs: 50,
    maxDelayMs: 200,
  });

  let task1Attempts = 0;
  const startCircuitTime = Date.now();

  const task1 = circuitLimiter.execute(async () => {
    task1Attempts++;
    if (task1Attempts === 1) {
      const err: any = new Error('Too many requests per second');
      err.code = 6;
      throw err;
    }
    return 'task1_success';
  }, 'circuit_task_1');

  // Задача 2 запускается параллельно, но должна быть заблокирована pausedUntil
  const task2 = circuitLimiter.execute(async () => {
    return 'task2_success';
  }, 'circuit_task_2');

  const [res1, res2] = await Promise.all([task1, task2]);
  const circuitDuration = Date.now() - startCircuitTime;

  if (res1 === 'task1_success' && res2 === 'task2_success' && circuitDuration >= 1400) {
    console.log(
      `✅ Тест Circuit Breaker пройден: ошибка 6 активировала pausedUntil, очередь задержана на ${circuitDuration}мс`
    );
  } else {
    throw new Error(
      `❌ Тест Circuit Breaker провален: duration=${circuitDuration}мс, res1=${res1}, res2=${res2}`
    );
  }

  // 3. Тест неповторимой ошибки (например, ошибка 15: Доступ запрещен)
  let nonRetryableFailed = false;
  try {
    await limiter.execute(async () => {
      const err: any = new Error('Access denied: post is private');
      err.code = 15;
      throw err;
    }, 'access_denied_test');
  } catch {
    nonRetryableFailed = true;
  }

  if (nonRetryableFailed) {
    console.log('✅ Тест неповторимой ошибки пройден: ошибка 15 не уходит в бесконечный ретрай!');
  } else {
    throw new Error('❌ Ошибка 15 должна была немедленно прервать выполнение!');
  }
}

runRateLimiterTests().catch((err) => {
  console.error('Ошибка в тестах rate limiter:', err);
  process.exit(1);
});
```

### 6.3 Baseline Build & Regression Testing

After implementing the changes, verification requires:
1. `npm run build`: Verify TypeScript compilation succeeds with zero errors.
2. `npm test`: Update `package.json` to execute all 5 suites:
   ```json
   "test": "tsx test/deduplication.test.ts && tsx test/excel.test.ts && tsx test/health.test.ts && tsx test/cleanup.test.ts && tsx test/vkRateLimiter.test.ts"
   ```
3. End-to-end simulated scrape test ensuring memory stability and clean file lifecycle.

---

## 7. Risk Assessment, Rollback Plan & Render Production Checklist

### 7.1 Risk Matrix & Mitigations

| Risk | Impact | Probability | Mitigation Strategy |
|:---|:---:|:---:|:---|
| **Race Condition during File Cleanup** (Attempting to delete a file while Telegram is streaming it) | Low | Low | Retention threshold is set to 30 minutes; grammY uploads take $<5$ seconds. In addition, `EBUSY`/`EPERM` errors are caught safely and skipped until the next sweep. |
| **Directory Unlink Errors (`EISDIR`/`EPERM`)** | Low | Low | `CleanupService.runCleanup()` verifies `if (!fileStat.isFile()) continue;`, preventing any attempt to unlink directories that match the `.xlsx` or `.tmp` pattern. |
| **Concurrent Button Double-Clicks (TOCTOU race condition)** | Medium | Medium | Synchronous lock (`session.isScraping = true;`) acquired immediately after check before any `await` calls, completely eliminating the asynchronous race window. |
| **Cascading Failures on VK Error 6** | High | Low | `VkRateLimiter` implements process-wide circuit breaker (`this.pausedUntil = Date.now() + 1500`), freezing all queued and incoming requests until VK's rate limit window resets. |
| **Comment Thread & Author Profile Truncation** | Medium | Low | Robust sequential 100-item pagination via `VkRateLimiter` guarantees complete thread replies and user author metadata without hitting VKScript 5-second CPU timeouts. |
| **Process Termination with Unfinished Scraping** (SIGTERM on deploy) | Low | Medium | Graceful shutdown hooks wait for active health server and bot polling stop. In-memory locks release cleanly on exit. |
| **Render Memory Consumption Spikes** | Low | Low | Rate limiter and cleanup service are lightweight pure TypeScript in-memory structures ($< 2$ MB RAM), easily fitting within Render's 512 MB free tier allowance. |

### 7.2 Rollback Plan

If unexpected regressions occur in production:
1. **Reverting Code:** Each change is isolated. Reverting `src/services/vk.ts`, `src/services/excel.ts`, `src/index.ts`, `src/config.ts`, and removing `cleanupService.ts` / `vkRateLimiter.ts` returns the bot to its exact initial state.
2. **Configuration Fallback:** Setting `EXCEL_MAX_AGE_MINUTES=0` or unsetting environment variables degrades gracefully to default values.
3. **No Database Migration Dependency:** Because session data is stored in-memory and state is stateless, no database rollbacks or data restorations are required.

### 7.3 Render Production Deployment Checklist

Before and during production deployment on Render:

- [ ] **Environment Variables:**
  - `TELEGRAM_BOT_TOKEN`: Active Telegram token from @BotFather.
  - `VK_SERVICE_TOKEN`: Application service token from `vk.com/dev`.
  - `DOWNLOADS_DIR`: `temp/downloads` (optional, defaults to `temp/downloads`).
  - `EXCEL_MAX_AGE_MINUTES`: `30` (optional, defaults to 30).
  - `CLEANUP_INTERVAL_MINUTES`: `15` (optional, defaults to 15).
  - `PORT`: Injected automatically by Render (default 3000).
- [ ] **Build Command:** Set in Render dashboard to `npm run build` or `npm install` (with `postinstall: npm run build`).
- [ ] **Start Command:** Set to `npm start` (`node server.js`).
- [ ] **Health Check URL:** Configure Render health check path to `/ping` (returns HTTP 200 `"pong"`).
- [ ] **Uptime Keepalive:** Configure UptimeRobot to ping `https://<your-render-subdomain>.onrender.com/ping` every 10 minutes.
- [ ] **Disk Verification:** Check initial sweep log `[CleanupService] Служба автоочистки запущена` in Render runtime console on startup.

---

## 8. Summary of Deliverables

When approved for implementation, the following files will be created or updated:

1. **New Files:**
   - `src/services/cleanupService.ts`: Periodic and startup disk auto-cleanup engine with directory deduplication (`Set`), `isFile()` subdirectory protection, and non-blocking scheduling.
   - `src/services/vkRateLimiter.ts`: Concurrency-serialized (`maxConcurrent: 1`), inter-request spaced (`minIntervalMs: 400ms`) rate limiter with global `pausedUntil` circuit breaker on Error 6 and jittered exponential retry.
   - `test/cleanup.test.ts`: Automated test suite for disk cleanup logic, age thresholding, `isFile()` directory skipping, and directory path deduplication.
   - `test/vkRateLimiter.test.ts`: Automated test suite for VK rate limiting, request pacing, strict concurrency serialization (`maxConcurrent: 1`), global circuit breaker on Error 6, and non-retryable error handling.
2. **Updated Files:**
   - `src/config.ts`: Centralized directory and cleanup threshold parameters.
   - `src/services/excel.ts`: Standardized export path pointing to configured downloads directory.
   - `src/services/vk.ts`: Integrated singleton client and rate-limited sequential execution wrapper (clean imports without unused `createCollectIterator`).
   - `src/bot.ts`: User session scraping lock (`isScraping`) with synchronous acquisition before any `await` calls to eliminate TOCTOU race conditions, descriptive Russian error notice for VK Error 29 (`RATE_LIMIT`), and guaranteed lock release in `finally`.
   - `src/index.ts`: Lifecycle hooks for cleanup service startup and graceful teardown.
   - `package.json`: Updated `test` script running all test suites.
   - `.env.example`: Documented new environment variables.

All proposed modifications strictly maintain backwards compatibility, preserve the existing NodeNext ESM architecture, and guarantee robust operation in production.
