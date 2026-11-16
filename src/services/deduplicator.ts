import {
  RawComment,
  DeduplicationMode,
  DeduplicationResult,
  ContestParticipant,
  DuplicateRecord,
  KeywordMatchType,
} from '../types.js';

export class DeduplicationService {
  /**
   * Очищает строку от концевых и начальных знаков препинания, кавычек, многоточий и пробелов
   * Поддерживает Unicode нормализацию (NFC) и замену буквы ё -> е (Defect 4.1 & 4.2)
   */
  public cleanText(text: string): string {
    if (!text || typeof text !== 'string') return '';
    return text
      .normalize('NFC')
      .replace(/ё/g, 'е')
      .replace(/Ё/g, 'е')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .replace(
        /^[\s!?,.:;«»"“”‘’'—–\-\u2212…/\\()\[\]{}#*~`]+|[\s!?,.:;«»"“”‘’'—–\-\u2212…/\\()\[\]{}#*~`]+$/gu,
        ''
      )
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  /**
   * Нормализует произвольный текст комментария для поиска (NFC, ё -> е, lowercase)
   */
  private normalizeForSearch(text: string): string {
    if (!text || typeof text !== 'string') return '';
    return text
      .normalize('NFC')
      .replace(/ё/g, 'е')
      .replace(/Ё/g, 'е')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .toLowerCase();
  }

  /**
   * Проверяет вхождение ключевого слова с учетом честных границ слов (Unicode word boundaries)
   */
  private matchesWordBoundary(text: string, cleanKeyword: string): boolean {
    const escapedWord = cleanKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^\\p{L}\\p{N}])${escapedWord}([^\\p{L}\\p{N}]|$)`, 'u');
    return regex.test(text);
  }

  /**
   * Выполняет хронологическую сортировку, фильтрацию по списку кодовых слов, дедупликацию и присвоение номеров
   */
  public processComments(
    rawComments: RawComment[],
    mode: DeduplicationMode = 'first_wins',
    includeReplies: boolean = false,
    keywords?: string[],
    keywordMatchType: KeywordMatchType = 'exact'
  ): DeduplicationResult {
    // Очищаем и оставляем только непустые кодовые слова
    const cleanKeywords = keywords
      ? keywords.map((k) => this.cleanText(k)).filter((k) => k.length > 0)
      : [];

    const hasKeywords = cleanKeywords.length > 0;

    // 1. Фильтруем ответы в ветках, если они отключены
    const filteredComments = includeReplies
      ? rawComments
      : rawComments.filter((c) => !c.isReply);

    // 2. Сортируем все комментарии строго по времени публикации (хронологически)
    const sortedComments = [...filteredComments].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    // 3. Группируем комментарии по уникальному идентификатору автора (userId)
    const userCommentsMap = new Map<string, RawComment[]>();
    for (const comment of sortedComments) {
      const existing = userCommentsMap.get(comment.userId) || [];
      existing.push(comment);
      userCommentsMap.set(comment.userId, existing);
    }

    const participants: ContestParticipant[] = [];
    const duplicates: DuplicateRecord[] = [];
    let currentNumber = 1;

    for (const [, userComments] of userCommentsMap.entries()) {
      const author = userComments[0];
      const commentCount = userComments.length;

      // Если задан список кодовых слов
      let eligibleComments = userComments;
      if (hasKeywords) {
        if (keywordMatchType === 'exact') {
          // Строгий режим: комментарий должен быть в точности равен ОДНОМУ из слов списка
          eligibleComments = userComments.filter((c) =>
            cleanKeywords.includes(this.cleanText(c.commentText))
          );

          if (eligibleComments.length === 0) {
            // Проверяем, встречалось ли хоть одно слово среди другого текста
            const containsAny = userComments.some((c) => {
              const normalized = this.normalizeForSearch(c.commentText);
              return cleanKeywords.some((k) => this.matchesWordBoundary(normalized, k));
            });

            const reason = containsAny
              ? `Содержит лишний текст (требовалось строго одно из кодовых слов: ${keywords?.join(' / ')})`
              : `Не содержит ни одного из кодовых слов (${keywords?.join(' / ')})`;

            duplicates.push({
              userId: author.userId,
              username: author.username,
              profileUrl: author.profileUrl,
              totalComments: commentCount,
              reason,
              comments: userComments.map((c) => ({
                text: c.commentText,
                createdAt: c.createdAt,
              })),
            });
            continue;
          }
        } else {
          // Мягкий режим: любое из слов списка может быть в любом месте текста с учетом границ слов
          eligibleComments = userComments.filter((c) => {
            const normalized = this.normalizeForSearch(c.commentText);
            return cleanKeywords.some((k) => this.matchesWordBoundary(normalized, k));
          });

          if (eligibleComments.length === 0) {
            duplicates.push({
              userId: author.userId,
              username: author.username,
              profileUrl: author.profileUrl,
              totalComments: commentCount,
              reason: `Не содержит ни одного из кодовых слов (${keywords?.join(' / ')})`,
              comments: userComments.map((c) => ({
                text: c.commentText,
                createdAt: c.createdAt,
              })),
            });
            continue;
          }
        }
      }

      const firstValidComment = eligibleComments[0];

      if (commentCount === 1) {
        // Честный единственный комментарий
        participants.push({
          number: currentNumber++,
          userId: firstValidComment.userId,
          username: firstValidComment.username,
          profileUrl: firstValidComment.profileUrl,
          commentText: firstValidComment.commentText,
          createdAt: firstValidComment.createdAt,
        });
      } else {
        // Участник оставил несколько комментариев
        if (mode === 'first_wins') {
          // Засчитываем только первый подходящий комментарий
          participants.push({
            number: currentNumber++,
            userId: firstValidComment.userId,
            username: firstValidComment.username,
            profileUrl: firstValidComment.profileUrl,
            commentText: firstValidComment.commentText,
            createdAt: firstValidComment.createdAt,
          });

          // Остальные комментарии отправляем в отчет о дубликатах
          duplicates.push({
            userId: author.userId,
            username: author.username,
            profileUrl: author.profileUrl,
            totalComments: commentCount,
            reason: `Оставлено ${commentCount} коммент. (учтен только 1-й, остальные ${commentCount - 1} отсеяны)`,
            comments: userComments.map((c) => ({
              text: c.commentText,
              createdAt: c.createdAt,
            })),
          });
        } else {
          // Режим 'disqualify': нарушитель дисквалифицирован за накрутку
          duplicates.push({
            userId: author.userId,
            username: author.username,
            profileUrl: author.profileUrl,
            totalComments: commentCount,
            reason: `Дисквалифицирован: оставлено ${commentCount} комментариев (накрутка)`,
            comments: userComments.map((c) => ({
              text: c.commentText,
              createdAt: c.createdAt,
            })),
          });
        }
      }
    }

    participants.sort((a, b) => a.number - b.number);

    return {
      participants,
      duplicates,
      totalRawComments: rawComments.length,
      uniqueAuthorsCount: userCommentsMap.size,
      keywordFilter: hasKeywords ? keywords : undefined,
      keywordMatchType: hasKeywords ? keywordMatchType : undefined,
    };
  }
}

export const deduplicator = new DeduplicationService();
