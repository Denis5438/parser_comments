import dotenv from 'dotenv';
import path from 'path';
dotenv.config();

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  vkServiceToken: process.env.VK_SERVICE_TOKEN || '',
  instagramSessionId: process.env.INSTAGRAM_SESSION_ID || '',
  port: parseInt(process.env.PORT || '3000', 10),
  downloadsDir: path.resolve(process.cwd(), process.env.DOWNLOADS_DIR || 'temp/downloads'),
  legacyOutputDir: path.resolve(process.cwd(), 'output'),
  excelMaxAgeMinutes: parseInt(process.env.EXCEL_MAX_AGE_MINUTES || '30', 10),
  cleanupIntervalMinutes: parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '15', 10),
  vkMinRequestIntervalMs: parseInt(process.env.VK_MIN_REQUEST_INTERVAL_MS || '400', 10),
  vkMaxConcurrentRequests: parseInt(process.env.VK_MAX_CONCURRENT_REQUESTS || '1', 10),
  vkMaxRetries: parseInt(process.env.VK_MAX_RETRIES || '5', 10),
  vkCircuitBreakerPauseMs: parseInt(process.env.VK_CIRCUIT_BREAKER_PAUSE_MS || '1500', 10),
};

export function validateConfig(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!config.telegramBotToken) {
    missing.push('TELEGRAM_BOT_TOKEN');
  }
  return {
    valid: missing.length === 0,
    missing,
  };
}
