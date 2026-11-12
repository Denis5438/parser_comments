import axios from 'axios';
import { RawComment, ScrapingOptions } from '../types.js';

interface DzenMetadata {
  documentId: string;
  publicationPublisherId?: string;
}

export class DzenScraper {
  private readonly botHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  };

  private readonly apiHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: 'https://dzen.ru/',
  };

  /**
   * Извлекает documentId (например, native:6a1eacf9...) и publicationPublisherId
   * со страницы публикации Дзена в обход капчи поисковым юзерагентом.
   */
  public async extractPublicationMetadata(url: string): Promise<DzenMetadata | null> {
    try {
      const normalizedUrl = url.replace('zen.yandex.ru', 'dzen.ru');
      const response = await axios.get(normalizedUrl, {
        headers: this.botHeaders,
        timeout: 15000,
        maxRedirects: 5,
      });

      const html = String(response.data);

      let documentId: string | null = null;
      let publicationPublisherId: string | undefined = undefined;

      // 1. Извлекаем из тега zen_object_id: <channelId>:<publicationId>
      const zenObjectMatch = html.match(/<meta property="zen_object_id" content="([a-f0-9]{24}):([a-f0-9]{24})"/i);
      if (zenObjectMatch) {
        publicationPublisherId = zenObjectMatch[1];
        documentId = `native:${zenObjectMatch[2]}`;
      }

      // 2. Если zen_object_id не найден, ищем documentId в теле скриптов
      if (!documentId) {
        const docMatch =
          html.match(/documentId":"(native:[a-f0-9]{24})"/i) ||
          html.match(/documentId=(native:[a-f0-9]{24})/i);
        if (docMatch) {
          documentId = docMatch[1];
        }
      }

      // 3. Извлекаем publicationPublisherId, если еще не найден
      if (!publicationPublisherId) {
        const pubMatch =
          html.match(/publicationPublisherId=([a-f0-9]{24})/i) ||
          html.match(/"publisher":\{"id":"([a-f0-9]{24})"/i);
        if (pubMatch) {
          publicationPublisherId = pubMatch[1];
        }
      }

      // 4. Запасной вариант: 24-значный hex ID прямо в URL
      if (!documentId) {
        const hexMatch = normalizedUrl.match(/([a-f0-9]{24})/i);
        if (hexMatch) {
          documentId = `native:${hexMatch[1]}`;
        }
      }

      if (documentId) {
        return { documentId, publicationPublisherId };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Загружает комментарии через внутренний API Дзена v2
   */
  public async fetchComments(url: string, options: ScrapingOptions): Promise<RawComment[]> {
    const meta = await this.extractPublicationMetadata(url);
    if (!meta || !meta.documentId) {
      throw new Error(
        'Не удалось определить ID публикации Дзен. Убедитесь, что публикация существует и открыта для чтения.'
      );
    }

    const { documentId, publicationPublisherId } = meta;
    const comments: RawComment[] = [];
    let fetchAfterCommentId: number | string | null = null;
    let hasMore = true;

    while (hasMore) {
      try {
        const params: Record<string, string | number> = {
          documentId,
          batchSize: 50,
          sorting: 'oldest',
        };

        if (publicationPublisherId) {
          params.publicationPublisherId = publicationPublisherId;
        }

        if (fetchAfterCommentId) {
          params.fetchAfterCommentId = fetchAfterCommentId;
        }

        const res = await axios.get('https://dzen.ru/api/comments/v2/root-comments', {
          params,
          headers: {
            ...this.apiHeaders,
            Referer: url,
          },
          timeout: 15000,
        });

        const data = res.data;
        const items = data?.items || [];
        const usersById = data?.usersById || {};
        const metaByCommentId = data?.metaByCommentId || {};

        if (!Array.isArray(items) || items.length === 0) {
          hasMore = false;
          break;
        }

        for (const item of items) {
          const ed = item.entityData;
          if (!ed) continue;

          const userKey = String(ed.authorSafeUid || ed.authorUid);
          const user = usersById[userKey] || usersById[String(ed.authorUid)] || {};
          const username =
            user.displayName || user.name || (user.publisher ? user.publisher.name : '') || 'Пользователь Дзен';
          const profileUrl = user.publicId
            ? `https://dzen.ru/user/${user.publicId}`
            : user.publisher?.channelPath
            ? `https://dzen.ru${user.publisher.channelPath}`
            : user.publisher?.id
            ? `https://dzen.ru/id/${user.publisher.id}`
            : '';

          comments.push({
            userId: String(ed.authorSafeUid || ed.authorUid || ed.id),
            username,
            profileUrl,
            commentText: ed.text || '',
            createdAt: new Date(ed.createdTs || Date.now()),
            commentId: String(ed.id),
            isReply: false,
          });

          // Вложенные ответы (если включена опция includeReplies)
          if (options.includeReplies) {
            const commentMeta = metaByCommentId[String(ed.id)] || metaByCommentId[ed.id];
            if (commentMeta && commentMeta.childrenCount > 0) {
              try {
                let childFetchAfter: string | number | null = null;
                let hasMoreChild = true;

                while (hasMoreChild) {
                  const childParams: Record<string, string | number> = {
                    rootCommentId: ed.id,
                    documentId,
                    batchSize: 50,
                  };
                  if (publicationPublisherId) {
                    childParams.publicationPublisherId = publicationPublisherId;
                  }
                  if (childFetchAfter) {
                    childParams.fetchAfterCommentId = childFetchAfter;
                  }

                  const childRes = await axios.get('https://dzen.ru/api/comments/v2/child-comments', {
                    params: childParams,
                    headers: {
                      ...this.apiHeaders,
                      Referer: url,
                    },
                    timeout: 10000,
                  });

                  const childItems = childRes.data?.items || [];
                  const childUsers = childRes.data?.usersById || {};

                  if (!Array.isArray(childItems) || childItems.length === 0) {
                    hasMoreChild = false;
                    break;
                  }

                  for (const child of childItems) {
                    const ced = child.entityData;
                    if (!ced) continue;

                    const cUserKey = String(ced.authorSafeUid || ced.authorUid);
                    const cUser = childUsers[cUserKey] || childUsers[String(ced.authorUid)] || {};
                    const cUsername =
                      cUser.displayName || cUser.name || (cUser.publisher ? cUser.publisher.name : '') || 'Пользователь Дзен';
                    const cProfileUrl = cUser.publicId
                      ? `https://dzen.ru/user/${cUser.publicId}`
                      : cUser.publisher?.channelPath
                      ? `https://dzen.ru${cUser.publisher.channelPath}`
                      : cUser.publisher?.id
                      ? `https://dzen.ru/id/${cUser.publisher.id}`
                      : '';

                    comments.push({
                      userId: String(ced.authorSafeUid || ced.authorUid || ced.id),
                      username: cUsername,
                      profileUrl: cProfileUrl,
                      commentText: ced.text || '',
                      createdAt: new Date(ced.createdTs || Date.now()),
                      commentId: String(ced.id),
                      isReply: true,
                    });
                  }

                  const lastChild = childItems[childItems.length - 1];
                  childFetchAfter = lastChild?.entityData?.id;
                  if (childItems.length < 50 || !childFetchAfter) {
                    hasMoreChild = false;
                  }
                }
              } catch (childErr) {
                console.warn(`[DZEN] Не удалось загрузить ветку ответов для комментария ${ed.id}:`, childErr);
              }
            }
          }
        }

        if (options.onProgress) {
          await options.onProgress(comments.length);
        }

        // Обновляем маркер следующей страницы
        const lastItem = items[items.length - 1];
        fetchAfterCommentId = lastItem?.entityData?.id;

        if (items.length < 50 || !fetchAfterCommentId) {
          hasMore = false;
        }
      } catch (err: any) {
        if (comments.length > 0) {
          break;
        }
        throw new Error(`Ошибка при сборе комментариев Дзен: ${err?.message || err}`);
      }
    }

    return comments;
  }
}

export const dzenScraper = new DzenScraper();
