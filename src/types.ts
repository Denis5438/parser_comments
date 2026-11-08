export type Platform = 'youtube' | 'vk' | 'dzen' | 'instagram' | 'unknown';

export type DeduplicationMode = 'first_wins' | 'disqualify';

export type KeywordMatchType = 'contains' | 'exact';

export interface RawComment {
  /** Уникальный идентификатор пользователя на платформе */
  userId: string;
  /** Имя или никнейм автора комментария */
  username: string;
  /** Прямая ссылка на профиль автора */
  profileUrl: string;
  /** Текст комментария */
  commentText: string;
  /** Дата и время создания комментария */
  createdAt: Date;
  /** ID комментария на платформе (для аудита) */
  commentId?: string;
  /** Является ли ответом в ветке (reply) */
  isReply?: boolean;
}

export interface ScrapingOptions {
  /** Учитывать ли вложенные ответы на комментарии */
  includeReplies: boolean;
  /** Фильтр по списку ключевых слов */
  keywords?: string[];
  /** Тип совпадения слова: в любом месте или строго точное */
  keywordMatchType?: KeywordMatchType;
  /** Функция для оповещения о прогрессе сбора */
  onProgress?: (count: number) => Promise<void> | void;
}

export interface ContestParticipant {
  /** Порядковый номер участника (1, 2, 3...) */
  number: number;
  userId: string;
  username: string;
  profileUrl: string;
  commentText: string;
  createdAt: Date;
}

export interface DuplicateRecord {
  userId: string;
  username: string;
  profileUrl: string;
  totalComments: number;
  reason: string;
  comments: {
    text: string;
    createdAt: Date;
  }[];
}

export interface DeduplicationResult {
  /** Итоговые валидные участники с присвоенными номерами */
  participants: ContestParticipant[];
  /** Исключенные дубликаты / нарушители / не прошедшие фильтр */
  duplicates: DuplicateRecord[];
  /** Всего обработано комментариев */
  totalRawComments: number;
  /** Количество уникальных авторов */
  uniqueAuthorsCount: number;
  /** Список кодовых слов, по которым фильтровали */
  keywordFilter?: string[];
  /** Тип сопоставления слова */
  keywordMatchType?: KeywordMatchType;
}
