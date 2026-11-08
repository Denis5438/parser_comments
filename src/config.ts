import dotenv from 'dotenv';
dotenv.config();

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  vkServiceToken: process.env.VK_SERVICE_TOKEN || '',
  instagramSessionId: process.env.INSTAGRAM_SESSION_ID || '',
  port: parseInt(process.env.PORT || '3000', 10),
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
