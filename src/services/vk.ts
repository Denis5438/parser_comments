import { VK } from 'vk-io';
import { RawComment, ScrapingOptions } from '../types.js';
import { config } from '../config.js';
import { vkLimiter } from './vkLimiter.js';

// Shared singleton VK client
let sharedVkClient: VK | null = null;
export function getVkClient(): VK {
  if (!sharedVkClient) {
    sharedVkClient = new VK({
      token: config.vkServiceToken,
      apiLimit: 2.5,
      apiMode: 'sequential',
      apiRequestMode: 'sequential',
      apiRetryLimit: 5,
      apiWait: 2000,
    });
  }
  return sharedVkClient;
}

export class VkScraper {
  /**
   * Извлекает тип объекта (wall или video), owner_id и item_id из ссылки ВКонтакте
   */
  public parseUrl(url: string): { type: 'wall' | 'video'; ownerId: number; itemId: number } | null {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      const search = parsed.search;

      // Формат feed?w=wall-123_456
      if (search.includes('w=wall') || search.includes('w=video')) {
        const match = search.match(/w=(wall|video)(-?\d+)_(\d+)/);
        if (match) {
          return {
            type: match[1] as 'wall' | 'video',
            ownerId: parseInt(match[2], 10),
            itemId: parseInt(match[3], 10),
          };
        }
      }

      // Формат /wall-123_456 или /video-123_456
      const directMatch = pathname.match(/\/(wall|video)(-?\d+)_(\d+)/);
      if (directMatch) {
        return {
          type: directMatch[1] as 'wall' | 'video',
          ownerId: parseInt(directMatch[2], 10),
          itemId: parseInt(directMatch[3], 10),
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Выкачивает комментарии к публикации или видео ВКонтакте
   */
  public async fetchComments(url: string, options: ScrapingOptions): Promise<RawComment[]> {
    const target = this.parseUrl(url);
    if (!target) {
      throw new Error(
        'Не удалось распознать ссылку VK. Поддерживаются ссылки вида vk.com/wall-123_456 или vk.com/video-123_456'
      );
    }

    if (!config.vkServiceToken) {
      throw new Error(
        'Не указан VK_SERVICE_TOKEN в файле .env. Создайте приложение на vk.com/dev и скопируйте сервисный ключ.'
      );
    }

    const vk = getVkClient();

    const comments: RawComment[] = [];
    let offset = 0;
    const count = 100;
    let totalCount = Infinity;

    while (offset < totalCount) {
      if (target.type === 'wall') {
        const response = await vkLimiter.execute(
          () =>
            vk.api.wall.getComments({
              owner_id: target.ownerId,
              post_id: target.itemId,
              offset,
              count,
              extended: 1,
              fields: ['screen_name', 'first_name', 'last_name'],
              need_likes: 0,
              thread_items_count: 10,
            }),
          `wall.getComments (offset ${offset})`
        );

        totalCount = response.count;
        if (!response.items || response.items.length === 0) {
          break;
        }

        const profilesMap = new Map<number, string>();
        for (const p of response.profiles || []) {
          profilesMap.set(p.id, `${p.first_name} ${p.last_name}`);
        }
        for (const g of response.groups || []) {
          profilesMap.set(-g.id, g.name || 'Сообщество');
        }

        for (const item of response.items) {
          // Игнорируем удаленные комментарии
          if (item.deleted) continue;

          const fromId = item.from_id;
          const authorName = profilesMap.get(fromId) || `ID ${fromId}`;
          const profileUrl = fromId > 0 ? `https://vk.com/id${fromId}` : `https://vk.com/club${Math.abs(fromId)}`;

          comments.push({
            userId: String(fromId),
            username: authorName,
            profileUrl,
            commentText: item.text || '',
            createdAt: new Date(item.date * 1000),
            commentId: String(item.id),
            isReply: Boolean(item.reply_to_comment || item.reply_to_user),
          });

          // Вложенная ветка ответов (threads)
          if (options.includeReplies && item.thread && item.thread.count > 0) {
            const threadComments: any[] = [];
            if (item.thread.items && item.thread.items.length > 0) {
              threadComments.push(...item.thread.items);
            }

            // Если в ветке больше комментариев, чем вернулось в превью (или превью не вернуло)
            let threadOffset = threadComments.length;
            while (threadOffset < item.thread.count) {
              const threadResponse = await vkLimiter.execute(
                () =>
                  vk.api.wall.getComments({
                    owner_id: target.ownerId,
                    post_id: target.itemId,
                    comment_id: item.id,
                    offset: threadOffset,
                    count: 100,
                    extended: 1,
                    fields: ['screen_name', 'first_name', 'last_name'],
                    need_likes: 0,
                  }),
                `wall.getComments thread ${item.id} (offset ${threadOffset})`
              );

              for (const p of threadResponse.profiles || []) {
                profilesMap.set(p.id, `${p.first_name} ${p.last_name}`);
              }
              for (const g of threadResponse.groups || []) {
                profilesMap.set(-g.id, g.name || 'Сообщество');
              }

              if (!threadResponse.items || threadResponse.items.length === 0) {
                break;
              }

              threadComments.push(...threadResponse.items);
              threadOffset += threadResponse.items.length;
            }

            for (const reply of threadComments) {
              if (reply.deleted) continue;

              const replyFromId = reply.from_id;
              const replyAuthorName = profilesMap.get(replyFromId) || `ID ${replyFromId}`;
              const replyUrl =
                replyFromId > 0
                  ? `https://vk.com/id${replyFromId}`
                  : `https://vk.com/club${Math.abs(replyFromId)}`;

              comments.push({
                userId: String(replyFromId),
                username: replyAuthorName,
                profileUrl: replyUrl,
                commentText: reply.text || '',
                createdAt: new Date(reply.date * 1000),
                commentId: String(reply.id),
                isReply: true,
              });
            }
          }
        }
      } else {
        // target.type === 'video'
        const response = await vkLimiter.execute(
          () =>
            vk.api.video.getComments({
              owner_id: target.ownerId,
              video_id: target.itemId,
              offset,
              count,
              extended: 1,
              need_likes: 0,
            }),
          `video.getComments (offset ${offset})`
        );

        totalCount = response.count;
        const profilesMap = new Map<number, string>();
        for (const p of response.profiles || []) {
          profilesMap.set(p.id, `${p.first_name} ${p.last_name}`);
        }
        for (const g of response.groups || []) {
          profilesMap.set(-g.id, g.name || 'Сообщество');
        }

        for (const item of response.items) {
          const fromId = item.from_id;
          const authorName = profilesMap.get(fromId) || `ID ${fromId}`;
          const profileUrl = fromId > 0 ? `https://vk.com/id${fromId}` : `https://vk.com/club${Math.abs(fromId)}`;

          comments.push({
            userId: String(fromId),
            username: authorName,
            profileUrl,
            commentText: item.message || '',
            createdAt: new Date(item.date * 1000),
            commentId: String(item.id),
            isReply: Boolean(item.reply_to_comment || item.reply_to_user),
          });
        }
      }

      offset += count;
      if (options.onProgress) {
        await options.onProgress(comments.length);
      }
    }

    return comments;
  }
}

export const vkScraper = new VkScraper();
