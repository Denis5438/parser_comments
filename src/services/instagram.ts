import axios from 'axios';
import { RawComment, ScrapingOptions } from '../types.js';
import { config } from '../config.js';

export class InstagramScraper {
  /**
   * Преобразует короткий код (shortcode) Инстаграма в числовой Media ID
   */
  public shortcodeToMediaId(shortcode: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(0);
    for (let i = 0; i < shortcode.length; i++) {
      const char = shortcode[i];
      const index = alphabet.indexOf(char);
      if (index === -1) continue;
      id = id * BigInt(64) + BigInt(index);
    }
    return id.toString();
  }

  /**
   * Извлекает shortcode из ссылки на публикацию/Reels Instagram
   */
  public extractShortcode(url: string): string | null {
    try {
      const match = url.match(/\/(p|reels?|tv)\/([A-Za-z0-9_-]+)/i);
      return match ? match[2] : null;
    } catch {
      return null;
    }
  }

  /**
   * Выкачивает комментарии к публикации Instagram по чистому HTTPS без запуска браузера
   */
  public async fetchComments(url: string, options: ScrapingOptions): Promise<RawComment[]> {
    const shortcode = this.extractShortcode(url);
    if (!shortcode) {
      throw new Error(
        'Не удалось распознать ссылку Instagram. Поддерживаются ссылки вида instagram.com/p/... или instagram.com/reel/...'
      );
    }

    const mediaId = this.shortcodeToMediaId(shortcode);
    const comments: RawComment[] = [];

    const headers: Record<string, string> = {
      'User-Agent':
        'Instagram 278.0.0.19.115 (iPhone14,3; iOS 16_5; ru_RU; ru-RU; scale=3.00; 1284x2778; 475283402) AppleWebKit/420+',
      'X-IG-App-ID': '936619743392459', // Стандартный публичный Web App ID Instagram
      Accept: '*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
    };

    if (config.instagramSessionId) {
      headers['Cookie'] = `sessionid=${config.instagramSessionId};`;
    }

    let cursor: string | null = null;
    let cursorParamName: 'min_id' | 'max_id' = 'min_id';
    let hasMore = true;
    let retryCount = 0;
    const MAX_PAGE_RETRIES = 3;

    while (hasMore) {
      try {
        const apiUrl = `https://www.instagram.com/api/v1/media/${mediaId}/comments/`;
        const params: Record<string, string | boolean> = {
          can_support_threading: true,
        };
        if (cursor) {
          params[cursorParamName] = cursor;
        }

        const res = await axios.get(apiUrl, {
          params,
          headers,
          timeout: 15000,
        });

        retryCount = 0;

        const data = res.data;

        // Если Инстаграм вернул страницу входа вместо JSON
        if (typeof data === 'string' && (data.includes('<html') || data.includes('login'))) {
          throw new Error(
            'Инстаграм ограничил публичный доступ к этой публикации (требует вход в аккаунт). ' +
              'Чтобы бот мог собирать комментарии из Instagram, укажите INSTAGRAM_SESSION_ID в файле .env.'
          );
        }

        if (data && typeof data === 'object' && data.status === 'fail') {
          throw new Error(
            `Инстаграм отклонил публичный запрос (${data.message || 'требуется авторизация'}). ` +
              `Укажите INSTAGRAM_SESSION_ID в файле .env.`
          );
        }

        const items = data?.comments || [];

        if (!Array.isArray(items) || items.length === 0) {
          hasMore = false;
          break;
        }

        for (const item of items) {
          const user = item.user || {};
          const userId = String(user.pk || user.id || user.username || 'unknown_ig_user');
          const username = user.username || 'Пользователь Instagram';
          const profileUrl = user.username ? `https://www.instagram.com/${user.username}/` : '';
          const text = item.text || '';
          const createdAt = item.created_at ? new Date(item.created_at * 1000) : new Date();

          comments.push({
            userId,
            username,
            profileUrl,
            commentText: text,
            createdAt,
            commentId: String(item.pk || item.id || ''),
            isReply: false,
          });

          // Вложенные ответы на комментарии (child comments / threading)
          if (options.includeReplies && Array.isArray(item.child_comments)) {
            for (const child of item.child_comments) {
              const childUser = child.user || {};
              const cUserId = String(childUser.pk || childUser.id || childUser.username || 'unknown_ig_user');
              comments.push({
                userId: cUserId,
                username: childUser.username || 'Пользователь Instagram',
                profileUrl: childUser.username ? `https://www.instagram.com/${childUser.username}/` : '',
                commentText: child.text || '',
                createdAt: child.created_at ? new Date(child.created_at * 1000) : new Date(),
                commentId: String(child.pk || child.id || ''),
                isReply: true,
              });
            }
          }
        }

        if (options.onProgress) {
          await options.onProgress(comments.length);
        }

        const nextMinId = data?.next_min_id;
        const nextMaxId = data?.next_max_id;
        if (nextMinId) {
          cursor = nextMinId;
          cursorParamName = 'min_id';
        } else if (nextMaxId) {
          cursor = nextMaxId;
          cursorParamName = 'max_id';
        } else {
          cursor = null;
        }

        const hasMoreComments = Boolean(data?.has_more_comments || data?.has_more_headload_comments);
        if (!cursor || !hasMoreComments) {
          hasMore = false;
        }
      } catch (err: any) {
        if (err?.response?.status === 400 || err?.response?.status === 401) {
          throw new Error(
            'Инстаграм ограничил публичный доступ к этой публикации. Укажите INSTAGRAM_SESSION_ID в .env для авторизованного сбора.'
          );
        }

        if (retryCount < MAX_PAGE_RETRIES) {
          retryCount++;
          const backoff = 1500 * Math.pow(2, retryCount - 1);
          console.warn(
            `[Instagram] Ошибка при сборе комментариев (${err?.message || err}). Повтор ${retryCount}/${MAX_PAGE_RETRIES} через ${backoff}мс...`
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }

        throw new Error(
          `Сбор комментариев Instagram прерван из-за сетевой ошибки после ${MAX_PAGE_RETRIES} попыток: ${err?.message || err}. Собрано ${comments.length} шт.`
        );
      }
    }

    return comments;
  }
}

export const instagramScraper = new InstagramScraper();
