import assert from 'node:assert';
import { instagramScraper } from '../src/services/instagram.js';
import { youtubeScraper, parseCommentDate } from '../src/services/youtube.js';
import { vkScraper } from '../src/services/vk.js';

console.log('🧪 Запуск тестов Scrapers (Instagram, YouTube, VK)...');

// =========================================================================
// 1. INSTAGRAM SHORTCODE & REELS PARSING (Defect 1.4)
// =========================================================================
console.log('\n--- Тест 1: Instagram Shortcode Parsing & /reels/ Support (Defect 1.4) ---');

// Тест /reels/ с разным регистром и слэшами
const reelsUrl1 = 'https://www.instagram.com/reels/C_7xyz123-_/';
assert.strictEqual(
  instagramScraper.extractShortcode(reelsUrl1),
  'C_7xyz123-_',
  'Ссылка /reels/ должна корректно парситься'
);

const reelsUrl2 = 'https://instagram.com/reels/ABCDEF123?utm_source=ig_web_copy_link';
assert.strictEqual(
  instagramScraper.extractShortcode(reelsUrl2),
  'ABCDEF123',
  'Ссылка /reels/ с query-параметрами должна корректно парситься'
);

// Тест стандартного /reel/
const reelUrl = 'https://www.instagram.com/reel/C89abcdef/';
assert.strictEqual(instagramScraper.extractShortcode(reelUrl), 'C89abcdef');

// Тест публикации /p/
const postUrl = 'https://www.instagram.com/p/B_123456789/';
assert.strictEqual(instagramScraper.extractShortcode(postUrl), 'B_123456789');

// Тест IGTV /tv/
const tvUrl = 'https://www.instagram.com/tv/XYZ987654/';
assert.strictEqual(instagramScraper.extractShortcode(tvUrl), 'XYZ987654');

// Неподдерживаемые или профильные ссылки должны возвращать null
assert.strictEqual(instagramScraper.extractShortcode('https://www.instagram.com/username/'), null);
assert.strictEqual(instagramScraper.extractShortcode('https://www.instagram.com/explore/'), null);
assert.strictEqual(instagramScraper.extractShortcode('invalid-url'), null);

// Проверка вычисления MediaId из shortcode
const mediaId = instagramScraper.shortcodeToMediaId('B_123456789');
assert.ok(typeof mediaId === 'string' && /^\d+$/.test(mediaId), 'MediaId должен быть строкой из цифр');

console.log('✅ Тест 1 пройден: Instagram shortcode парсер корректно поддерживает /reels/, /reel/, /p/, /tv/');

// =========================================================================
// 2. YOUTUBE VIDEO ID & DATE PARSER (Defect 1.5)
// =========================================================================
console.log('\n--- Тест 2: YouTube Video ID & Date Parser (Defect 1.5) ---');

// Тесты парсинга URL YouTube: watch?v=, youtu.be/, /shorts/, embed/
assert.strictEqual(youtubeScraper.extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(youtubeScraper.extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(youtubeScraper.extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(youtubeScraper.extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

// Тесты parseCommentDate
// 1) Точный timestamp в микросекундах (timestampUsec)
const usecDate = parseCommentDate('1700000000000000');
assert.strictEqual(usecDate.getTime(), 1700000000000, 'timestampUsec должен переводиться в миллисекунды');

// 2) Относительное время на русском
const nowMs = Date.now();
const dateHoursAgo = parseCommentDate(undefined, '2 часа назад');
const diffHours = (nowMs - dateHoursAgo.getTime()) / (3600 * 1000);
assert.ok(Math.abs(diffHours - 2) < 0.1, 'Разница должна составлять примерно 2 часа');

const dateDaysAgo = parseCommentDate(undefined, '3 дня назад');
const diffDays = (nowMs - dateDaysAgo.getTime()) / (86400 * 1000);
assert.ok(Math.abs(diffDays - 3) < 0.1, 'Разница должна составлять примерно 3 дня');

// 3) Относительное время на английском
const dateMinAgo = parseCommentDate(undefined, '10 minutes ago');
const diffMin = (nowMs - dateMinAgo.getTime()) / (60 * 1000);
assert.ok(Math.abs(diffMin - 10) < 0.1, 'Разница должна составлять примерно 10 минут');

console.log('✅ Тест 2 пройден: YouTube videoId и точные даты комментариев парсятся корректно');

// =========================================================================
// 3. VK URL PARSER
// =========================================================================
console.log('\n--- Тест 3: VK URL Parser ---');

const vkWall = vkScraper.parseUrl('https://vk.com/wall-123456_789');
assert.deepStrictEqual(vkWall, { type: 'wall', ownerId: -123456, itemId: 789 });

const vkVideo = vkScraper.parseUrl('https://vk.com/video-123456_999999');
assert.deepStrictEqual(vkVideo, { type: 'video', ownerId: -123456, itemId: 999999 });

const vkFeedWall = vkScraper.parseUrl('https://vk.com/feed?w=wall100_200');
assert.deepStrictEqual(vkFeedWall, { type: 'wall', ownerId: 100, itemId: 200 });

console.log('✅ Тест 3 пройден: VK URL парсер корректно распознает wall и video ссылки');

console.log('\n🎉 ВСЕ ТЕСТЫ SCRAPERS УСПЕШНО ПРОЙДЕНЫ!');
