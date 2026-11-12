import { config } from '../config.js';

export interface RateLimiterOptions {
  tokensPerSecond: number;
  bucketCapacity: number;
  maxConcurrent: number;
  minIntervalMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  circuitBreakerPauseMs?: number;
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
  private readonly circuitBreakerPauseMs: number;
  private queue: Array<() => void> = [];
  private isProcessingQueue: boolean = false;

  constructor(options?: Partial<RateLimiterOptions>) {
    this.tokensPerSecond = options?.tokensPerSecond ?? 2.5; // Максимум 2.5 req/sec (при лимите VK 3 req/sec)
    this.bucketCapacity = options?.bucketCapacity ?? 1;     // Емкость 1 устраняет всплески при t=0
    this.maxConcurrent = options?.maxConcurrent ?? (config as any)?.vkMaxConcurrentRequests ?? 1; // Строгая сериализация: не более 1 активного запроса к VK API
    this.minIntervalMs = options?.minIntervalMs ?? (config as any)?.vkMinRequestIntervalMs ?? Math.floor(1000 / this.tokensPerSecond); // Межинтервальная пауза (400мс)
    this.maxRetries = options?.maxRetries ?? (config as any)?.vkMaxRetries ?? 5;
    this.baseDelayMs = options?.baseDelayMs ?? 600;
    this.maxDelayMs = options?.maxDelayMs ?? 12000;
    this.circuitBreakerPauseMs = options?.circuitBreakerPauseMs ?? (config as any)?.vkCircuitBreakerPauseMs ?? 1500;

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
   * Возвращает количество задач в очереди ожидания.
   */
  public getQueueLength(): number {
    return this.queue.length;
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
    if (this.queue.length === 0) {
      return;
    }

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
    const errCodeStr = String(code || '').toUpperCase();
    if (
      errCodeStr === 'ETIMEDOUT' ||
      errCodeStr === 'ECONNRESET' ||
      errCodeStr === 'ECONNREFUSED' ||
      errCodeStr === 'EAI_AGAIN'
    ) {
      return true;
    }

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
          this.pausedUntil = Math.max(this.pausedUntil, Date.now() + this.circuitBreakerPauseMs);
          console.warn(
            `[VkRateLimiter] Получена ошибка 6 (TOO_MANY) в "${taskName}". Очередь глобально заморожена на ${this.circuitBreakerPauseMs}мс.`
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

export class VkLimiter extends VkRateLimiter {}

export const vkRateLimiter = new VkRateLimiter();
export const vkLimiter = vkRateLimiter;
export default vkRateLimiter;
