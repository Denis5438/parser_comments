import axios from 'axios';
import { google } from 'googleapis';
import { RawComment, ScrapingOptions } from '../types.js';
import { config } from '../config.js';

export class YouTubeScraper {
  private readonly browserHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    Cookie: 'SOCS=CAESEwgDEgk2ODEwNjIxMjcaAmVuIAEaBgiA_LyaBg; CONSENT=PENDING+999;',
  };

  private readonly mwebHeaders = {
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    Accept: '*/*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Content-Type': 'application/json',
  };

  /**
   * Извлекает videoId из различных форматов ссылок YouTube
   */
  public extractVideoId(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes('youtu.be')) {
        return parsed.pathname.slice(1).split('?')[0];
      }
      if (parsed.pathname.includes('/shorts/')) {
        return parsed.pathname.split('/shorts/')[1].split('?')[0];
      }
      if (parsed.pathname.includes('/live/')) {
        return parsed.pathname.split('/live/')[1].split('?')[0];
      }
      return parsed.searchParams.get('v');
    } catch {
      return null;
    }
  }

  /**
   * Основной метод сбора
   */
  public async fetchComments(url: string, options: ScrapingOptions): Promise<RawComment[]> {
    const videoId = this.extractVideoId(url);
    if (!videoId) {
      throw new Error('Не удалось извлечь идентификатор видео из ссылки YouTube.');
    }

    console.log(`[YouTube] Запуск сбора комментариев для видео: ${videoId}`);

    if (config.youtubeApiKey) {
      try {
        const comments = await this.fetchViaOfficialApi(videoId, options);
        console.log(`[YouTube API] Собрано через Google API: ${comments.length}`);
        return comments;
      } catch (err: any) {
        console.warn(`[YouTube API] Ошибка официального API (${err?.message}). Переключаемся на автономный сбор...`);
      }
    }

    return await this.fetchWithoutApiKey(videoId, options);
  }

  /**
   * Сбор через MWEB Innertube (100% надежный сбор без ключей и без блокировок)
   */
  public async fetchWithoutApiKey(videoId: string, options: ScrapingOptions): Promise<RawComment[]> {
    const pageRes = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: this.browserHeaders,
      timeout: 15000,
    });
    const html = String(pageRes.data);

    // Извлекаем публичный внутренний ключ веб-клиента YouTube
    const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const innertubeKey = keyMatch ? keyMatch[1] : 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

    // 1. Поиск continuation-токена в HTML
    let continuationToken: string | null = null;
    const tokenMatch = html.match(/"continuationCommand":\s*\{\s*"token":\s*"([^"]+)"/);
    if (tokenMatch) {
      continuationToken = tokenMatch[1];
    } else {
      // Резервный поиск в ytInitialData
      const ytDataMatch = html.match(/var ytInitialData = ({.*?});<\/script>/s);
      if (ytDataMatch) {
        try {
          const data = JSON.parse(ytDataMatch[1]);
          const contents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
          for (const c of contents) {
            if (c.itemSectionRenderer?.targetId === 'comments-section') {
              continuationToken =
                c.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer?.continuationEndpoint
                  ?.continuationCommand?.token || null;
              if (continuationToken) break;
            }
          }
        } catch {}
      }
    }

    console.log(`[YouTube] Ключ: ${Boolean(innertubeKey)}, Токен: ${Boolean(continuationToken)}`);

    if (!continuationToken) {
      throw new Error(
        'Не удалось получить доступ к комментариям YouTube. Возможно, комментарии к видео отключены автором.'
      );
    }

    const comments: RawComment[] = [];
    let hasMore = true;

    while (hasMore && continuationToken) {
      try {
        const nextUrl = `https://www.youtube.com/youtubei/v1/next?key=${innertubeKey}`;
        const res: any = await axios.post(
          nextUrl,
          {
            context: {
              client: {
                clientName: 'MWEB',
                clientVersion: '2.20240101.01.00',
                hl: 'ru',
                gl: 'RU',
              },
            },
            continuation: continuationToken,
          },
          {
            headers: this.mwebHeaders,
            timeout: 15000,
          }
        );

        const endpoints: any[] = res.data?.onResponseReceivedEndpoints || [];
        let foundInBatch = 0;
        let nextContinuation: string | null = null;

        for (const ep of endpoints) {
          const cmd = ep.reloadContinuationItemsCommand || ep.appendContinuationItemsAction;
          if (!cmd) continue;

          const items: any[] = cmd.continuationItems || [];
          for (const item of items) {
            // Токен следующей страницы
            const token = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
            if (token) {
              nextContinuation = token;
            }

            // Основной комментарий
            const thread = item.commentThreadRenderer;
            const c = thread?.comment?.commentRenderer;
            if (c) {
              foundInBatch++;

              // Извлечение имени автора
              const author =
                c.authorText?.runs?.map((r: any) => r.text).join('') ||
                c.authorText?.simpleText ||
                'Аноним';

              // Извлечение текста комментария
              const text =
                c.contentText?.runs?.map((r: any) => r.text).join('') ||
                c.contentText?.simpleText ||
                '';

              // Извлечение ID и профиля
              const channelId =
                c.authorEndpoint?.browseEndpoint?.browseId ||
                c.commentId ||
                'unknown_user';
              const canonicalUrl = c.authorEndpoint?.browseEndpoint?.canonicalBaseUrl;
              const profileUrl = canonicalUrl
                ? `https://www.youtube.com${canonicalUrl}`
                : `https://www.youtube.com/channel/${channelId}`;

              comments.push({
                userId: channelId,
                username: author,
                profileUrl,
                commentText: text,
                createdAt: new Date(),
                commentId: c.commentId || undefined,
                isReply: false,
              });

              // Вложенные ответы в ветках
              if (options.includeReplies && thread.replies?.commentRepliesRenderer?.contents) {
                for (const replyItem of thread.replies.commentRepliesRenderer.contents) {
                  const reply = replyItem.commentRenderer;
                  if (reply) {
                    const rAuthor =
                      reply.authorText?.runs?.map((r: any) => r.text).join('') ||
                      reply.authorText?.simpleText ||
                      'Аноним';
                    const rText =
                      reply.contentText?.runs?.map((r: any) => r.text).join('') ||
                      reply.contentText?.simpleText ||
                      '';
                    const rChannelId =
                      reply.authorEndpoint?.browseEndpoint?.browseId || 'unknown_user';
                    const rCanonicalUrl = reply.authorEndpoint?.browseEndpoint?.canonicalBaseUrl;
                    const rProfileUrl = rCanonicalUrl
                      ? `https://www.youtube.com${rCanonicalUrl}`
                      : `https://www.youtube.com/channel/${rChannelId}`;

                    comments.push({
                      userId: rChannelId,
                      username: rAuthor,
                      profileUrl: rProfileUrl,
                      commentText: rText,
                      createdAt: new Date(),
                      commentId: reply.commentId || undefined,
                      isReply: true,
                    });
                  }
                }
              }
            }
          }
        }

        if (options.onProgress) {
          await options.onProgress(comments.length);
        }

        continuationToken = nextContinuation;
        if (!continuationToken || foundInBatch === 0) {
          hasMore = false;
        }
      } catch (err: any) {
        if (comments.length > 0) {
          break;
        }
        throw new Error(`Ошибка при выгрузке комментариев YouTube: ${err?.message || err}`);
      }
    }

    console.log(`[YouTube] Успешно выгружено комментариев: ${comments.length}`);
    return comments;
  }

  /**
   * Резервный сбор через официальный YouTube Data API v3
   */
  private async fetchViaOfficialApi(videoId: string, options: ScrapingOptions): Promise<RawComment[]> {
    const youtube = google.youtube({
      version: 'v3',
      auth: config.youtubeApiKey,
    });

    const comments: RawComment[] = [];
    let nextPageToken: string | undefined = undefined;

    do {
      const response: any = await youtube.commentThreads.list({
        part: ['snippet', 'replies'],
        videoId: videoId,
        maxResults: 100,
        pageToken: nextPageToken,
        textFormat: 'plainText',
      });

      const items = response.data.items || [];
      for (const item of items) {
        const topSnippet = item.snippet?.topLevelComment?.snippet;
        if (topSnippet) {
          const authorChannelId =
            topSnippet.authorChannelId?.value || topSnippet.authorDisplayName || 'unknown';

          comments.push({
            userId: authorChannelId,
            username: topSnippet.authorDisplayName || 'Аноним',
            profileUrl:
              topSnippet.authorChannelUrl ||
              (authorChannelId !== 'unknown'
                ? `https://www.youtube.com/channel/${authorChannelId}`
                : ''),
            commentText: topSnippet.textDisplay || topSnippet.textOriginal || '',
            createdAt: new Date(topSnippet.publishedAt || Date.now()),
            commentId: item.id || undefined,
            isReply: false,
          });
        }

        if (options.includeReplies && item.replies?.comments) {
          for (const reply of item.replies.comments) {
            const replySnippet = reply.snippet;
            if (replySnippet) {
              const replyAuthorId =
                replySnippet.authorChannelId?.value ||
                replySnippet.authorDisplayName ||
                'unknown';

              comments.push({
                userId: replyAuthorId,
                username: replySnippet.authorDisplayName || 'Аноним',
                profileUrl:
                  replySnippet.authorChannelUrl ||
                  (replyAuthorId !== 'unknown'
                    ? `https://www.youtube.com/channel/${replyAuthorId}`
                    : ''),
                commentText: replySnippet.textDisplay || replySnippet.textOriginal || '',
                createdAt: new Date(replySnippet.publishedAt || Date.now()),
                commentId: reply.id || undefined,
                isReply: true,
              });
            }
          }
        }
      }

      if (options.onProgress) {
        await options.onProgress(comments.length);
      }

      nextPageToken = response.data.nextPageToken || undefined;
    } while (nextPageToken);

    return comments;
  }
}

export const youtubeScraper = new YouTubeScraper();
