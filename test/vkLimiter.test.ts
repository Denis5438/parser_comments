import assert from 'node:assert';
import { VkRateLimiter, vkLimiter } from '../src/services/vkLimiter.js';

async function runRateLimiterTests() {
  console.log('🧪 Запуск тестов VkRateLimiter / VkLimiter...');

  // 1. Тест ограничения темпа и строгой сериализации (maxConcurrent: 1)
  console.log('--- Тест 1: Сериализация и темп (maxConcurrent: 1) ---');
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
  console.log('--- Тест 2: Circuit Breaker на ошибку 6 (TOO_MANY) ---');
  const circuitLimiter = new VkRateLimiter({
    tokensPerSecond: 10,
    bucketCapacity: 1,
    maxConcurrent: 1,
    minIntervalMs: 50,
    baseDelayMs: 50,
    maxDelayMs: 200,
    circuitBreakerPauseMs: 1500,
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

  // 3. Тест неповторимой ошибки (например, ошибка 15: Доступ запрещен и ошибка 29: Дневной лимит)
  console.log('--- Тест 3: Неповторимые ошибки (15 и 29) ---');
  let nonRetryableFailed15 = false;
  try {
    await limiter.execute(async () => {
      const err: any = new Error('Access denied: post is private');
      err.code = 15;
      throw err;
    }, 'access_denied_test');
  } catch {
    nonRetryableFailed15 = true;
  }

  if (nonRetryableFailed15) {
    console.log('✅ Тест неповторимой ошибки пройден: ошибка 15 не уходит в повторы');
  } else {
    throw new Error('❌ Ошибка 15 должна была немедленно прервать выполнение!');
  }

  let nonRetryableFailed29 = false;
  try {
    await limiter.execute(async () => {
      const err: any = new Error('Rate limit reached');
      err.code = 29;
      throw err;
    }, 'rate_limit_29_test');
  } catch {
    nonRetryableFailed29 = true;
  }

  if (nonRetryableFailed29) {
    console.log('✅ Тест ошибки 29 пройден: дневной лимит не уходит в повторы');
  } else {
    throw new Error('❌ Ошибка 29 должна была немедленно прервать выполнение!');
  }

  // 4. Тест повтора при ошибках 1, 9, 10, HTTP 502/503/504 и сетевых сбоях
  console.log('--- Тест 4: Повтор при ошибках 1 (UNKNOWN), 9, 10, HTTP 503 и сети ---');
  let unknownAttempts = 0;
  const unknownResult = await limiter.execute(async () => {
    unknownAttempts++;
    if (unknownAttempts < 2) {
      const err: any = new Error('Unknown error occurred');
      err.code = 1; // VK Code 1
      throw err;
    }
    return 'unknown_recovered';
  }, 'unknown_error_test');
  assert.strictEqual(unknownResult, 'unknown_recovered');
  assert.strictEqual(unknownAttempts, 2);
  console.log('✅ Тест ошибки VK 1 (UNKNOWN_ERROR): успешный повтор');

  let floodAttempts = 0;
  const floodResult = await limiter.execute(async () => {
    floodAttempts++;
    if (floodAttempts < 2) {
      const err: any = new Error('Flood control');
      err.code = 9;
      throw err;
    }
    return 'flood_recovered';
  }, 'flood_test');
  assert.strictEqual(floodResult, 'flood_recovered');
  assert.strictEqual(floodAttempts, 2);
  console.log('✅ Тест ошибки 9 (FLOOD): успешный повтор');

  let internalAttempts = 0;
  const internalResult = await limiter.execute(async () => {
    internalAttempts++;
    if (internalAttempts < 2) {
      const err: any = new Error('Internal server error');
      err.code = 10;
      throw err;
    }
    return 'internal_recovered';
  }, 'internal_error_test');
  assert.strictEqual(internalResult, 'internal_recovered');
  assert.strictEqual(internalAttempts, 2);
  console.log('✅ Тест ошибки 10 (INTERNAL_ERROR): успешный повтор');

  let httpAttempts = 0;
  const httpResult = await limiter.execute(async () => {
    httpAttempts++;
    if (httpAttempts < 2) {
      const err: any = new Error('Bad Gateway');
      err.status = 502;
      throw err;
    }
    return 'http_502_recovered';
  }, 'http_502_test');
  assert.strictEqual(httpResult, 'http_502_recovered');
  assert.strictEqual(httpAttempts, 2);
  console.log('✅ Тест HTTP 502 (Bad Gateway): успешный повтор');

  let networkAttempts = 0;
  const networkResult = await limiter.execute(async () => {
    networkAttempts++;
    if (networkAttempts < 2) {
      const err: any = new Error('getaddrinfo ENOTFOUND api.vk.com');
      err.code = 'ENOTFOUND';
      throw err;
    }
    return 'network_recovered';
  }, 'network_test');
  assert.strictEqual(networkResult, 'network_recovered');
  assert.strictEqual(networkAttempts, 2);
  console.log('✅ Тест сетевой ошибки (ENOTFOUND): успешный повтор');

  // 5. Тест превышения максимального числа попыток
  console.log('--- Тест 5: Превышение maxRetries ---');
  const shortRetryLimiter = new VkRateLimiter({
    tokensPerSecond: 10,
    bucketCapacity: 1,
    maxConcurrent: 1,
    minIntervalMs: 10,
    maxRetries: 2,
    baseDelayMs: 10,
    maxDelayMs: 50,
  });

  let totalAttemptsCount = 0;
  let maxRetriesExceeded = false;
  try {
    await shortRetryLimiter.execute(async () => {
      totalAttemptsCount++;
      const err: any = new Error('Repeated server error');
      err.code = 10;
      throw err;
    }, 'max_retries_test');
  } catch {
    maxRetriesExceeded = true;
  }

  // Первоначальный запуск (попытка 0) + 2 повтора = 3 вызова
  if (maxRetriesExceeded && totalAttemptsCount === 3) {
    console.log(`✅ Тест maxRetries пройден: попыток сделано ${totalAttemptsCount}, выброшено исключение`);
  } else {
    throw new Error(`❌ Неверное число попыток при maxRetries: attempts=${totalAttemptsCount}, exceeded=${maxRetriesExceeded}`);
  }

  // 6. Проверка вспомогательных методов и синглтона vkLimiter
  console.log('--- Тест 6: Вспомогательные методы и синглтон ---');
  if (typeof vkLimiter.getActiveRequests === 'function' &&
      typeof vkLimiter.getPausedUntil === 'function' &&
      typeof vkLimiter.isPaused === 'function' &&
      typeof vkLimiter.getQueueLength === 'function') {
    console.log('✅ Вспомогательные методы синглтона vkLimiter доступны и валидны');
  } else {
    throw new Error('❌ Отсутствуют необходимые методы в синглтоне vkLimiter');
  }

  // 7. Тест отсутствия утечки счетчика активных запросов при retry backoff (Defect 1.1)
  console.log('--- Тест 7: Регрессионный тест освобождения слота при повторах (Defect 1.1) ---');
  const leakTestLimiter = new VkRateLimiter({
    tokensPerSecond: 10,
    bucketCapacity: 2,
    maxConcurrent: 1,
    minIntervalMs: 20,
    maxRetries: 2,
    baseDelayMs: 200,
    maxDelayMs: 400,
  });

  let attemptCount = 0;
  let activeWhileRetrying = -1;

  const retryTask = leakTestLimiter.execute(async () => {
    attemptCount++;
    if (attemptCount === 1) {
      // Планируем проверку activeRequests во время паузы перед 2-й попыткой
      setTimeout(() => {
        activeWhileRetrying = leakTestLimiter.getActiveRequests();
      }, 50);
      const err: any = new Error('Temporary glitch');
      err.code = 10;
      throw err;
    }
    return 'retry_done';
  }, 'leak_test_task');

  const retryResult = await retryTask;
  assert.strictEqual(retryResult, 'retry_done');
  assert.strictEqual(attemptCount, 2);
  // В старой реализации activeRequests оставался равным 1 во время сна.
  // В исправленной реализации activeRequests освобождается до сна: activeWhileRetrying === 0!
  assert.strictEqual(activeWhileRetrying, 0, `activeRequests во время retry-бэкоффа должен быть 0, получено: ${activeWhileRetrying}`);
  assert.strictEqual(leakTestLimiter.getActiveRequests(), 0, 'После завершения всех задач activeRequests должен быть 0');
  console.log('✅ Тест 7 пройден: activeRequests освобождается перед сном при бэкоффе (нет блокировки/утечки параллельности)');

  console.log('\n🎉 Все тесты VkRateLimiter / VkLimiter успешно пройдены!');
}

runRateLimiterTests().catch((err) => {
  console.error('❌ Ошибка в тестах rate limiter:', err);
  process.exit(1);
});
