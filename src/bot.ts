import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { config, validateConfig } from './config.js';
import {
  Platform,
  DeduplicationMode,
  DeduplicationResult,
  RawComment,
  KeywordMatchType,
} from './types.js';
import { youtubeScraper } from './services/youtube.js';
import { vkScraper } from './services/vk.js';
import { dzenScraper } from './services/dzen.js';
import { instagramScraper } from './services/instagram.js';
import { deduplicator } from './services/deduplicator.js';
import { excelService } from './services/excel.js';

interface UserSession {
  url: string;
  platform: Platform;
  mode: DeduplicationMode;
  includeReplies: boolean;
  keywords?: string[];
  keywordMatchType: KeywordMatchType;
  awaitingKeywordInput?: boolean;
  lastResult?: DeduplicationResult;
  lastReportPath?: string;
  isScraping?: boolean;
}

const sessions = new Map<number, UserSession>();

export function createBot(): Bot {
  const { valid, missing } = validateConfig();
  if (!valid) {
    console.warn(`[ВНИМАНИЕ] Не заполнены переменные окружения: ${missing.join(', ')}`);
  }

  const bot = new Bot(config.telegramBotToken || 'DUMMY_TOKEN_FOR_BUILD');

  // Глобальный обработчик ошибок (чтобы бот НИКОГДА не падал)
  bot.catch((err: any) => {
    console.error('[GrammY] Перехвачена ошибка в обработчике:', err.error?.message || err?.message || err);
  });

  // Безопасный ответ на callback_query
  const safeAnswerCallback = async (ctx: any, text?: string) => {
    try {
      if (text) {
        await ctx.answerCallbackQuery({ text });
      } else {
        await ctx.answerCallbackQuery();
      }
    } catch {}
  };

  // Определитель платформы по URL
  const detectPlatform = (url: string): Platform => {
    try {
      const lower = url.toLowerCase();
      if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
      if (
        lower.includes('vk.com') ||
        lower.includes('vk.ru') ||
        lower.includes('vkvideo.ru') ||
        lower.includes('m.vk.com')
      )
        return 'vk';
      if (lower.includes('dzen.ru') || lower.includes('zen.yandex.ru')) return 'dzen';
      if (lower.includes('instagram.com') || lower.includes('instagr.am')) return 'instagram';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };

  // Команда /start
  bot.command('start', async (ctx) => {
    const welcome =
      `👋 <b>Привет! Я бот для проведения честных розыгрышей и конкурсов.</b>\n\n` +
      `Я умею:\n` +
      `✅ Автоматически собирать комментарии под публикацией\n` +
      `✅ <b>Исключать повторы</b> — тех, кто хитрит и пишет по несколько раз\n` +
      `✅ <b>Фильтровать по списку кодовых слов</b> (каждое с новой строки)\n` +
      `✅ <b>Режимы поиска</b>: строго точное совпадение или в любом месте текста\n` +
      `✅ Игнорировать вложенные ответы в ветках (брать только основные комменты)\n` +
      `✅ Присваивать каждому участнику честный порядковый номер (1, 2, 3...)\n` +
      `✅ Формировать стильную таблицу Excel для аудита\n` +
      `✅ Определять победителя через встроенный рандомайзер\n\n` +
      `<b>Поддерживаемые площадки:</b>\n` +
      `• YouTube (видео и Shorts)\n` +
      `• ВКонтакте (посты и видео)\n` +
      `• Дзен (статьи, посты и видео)\n` +
      `• Instagram (посты и Reels)\n\n` +
      `👇 <i>Просто отправьте мне ссылку на публикацию с конкурсом!</i>`;

    await ctx.reply(welcome, { parse_mode: 'HTML' });
  });

  // Обработка текстовых сообщений
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    const session = sessions.get(ctx.chat.id);

    // Если бот ожидал ввод ключевых слов от пользователя
    if (session && session.awaitingKeywordInput) {
      session.awaitingKeywordInput = false;

      // Разбиваем строго по переводу строки (\n)
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (
        lines.length === 1 &&
        (lines[0] === '0' ||
          lines[0].toLowerCase() === 'сброс' ||
          lines[0].toLowerCase() === 'отмена' ||
          lines[0].toLowerCase() === 'все')
      ) {
        session.keywords = undefined;
        await ctx.reply('✅ Фильтр по словам сброшен: собираем <b>все</b> комментарии.', {
          parse_mode: 'HTML',
        });
      } else {
        session.keywords = lines;
        session.keywordMatchType = 'exact'; // По умолчанию строгое совпадение
        const listFormatted = lines.map((w, i) => `  ${i + 1}. «<b>${w}</b>»`).join('\n');
        await ctx.reply(
          `✅ Установлены кодовые слова (${lines.length} шт.):\n${listFormatted}\n\n` +
            `По умолчанию включен режим: <b>«🎯 Строго точное совпадение»</b> (комментарий должен быть равен любому из этих слов без лишнего текста).`,
          { parse_mode: 'HTML' }
        );
      }
      await sendSettingsMenu(ctx, session);
      return;
    }

    if (!text.startsWith('http://') && !text.startsWith('https://')) {
      await ctx.reply('❌ Пожалуйста, отправьте корректную ссылку на публикацию (начинается с https://)');
      return;
    }

    const platform = detectPlatform(text);
    if (platform === 'unknown') {
      await ctx.reply(
        '❌ Не удалось распознать платформу. Поддерживаются ссылки на YouTube, ВКонтакте, Дзен и Instagram.'
      );
      return;
    }

    console.log(`[BOT] Пользователь @${ctx.from?.username || ctx.from?.id} прислал ссылку: ${text} (${platform})`);

    const newSession: UserSession = {
      url: text,
      platform,
      mode: 'first_wins',
      includeReplies: false,
      keywords: undefined,
      keywordMatchType: 'exact',
    };
    sessions.set(ctx.chat.id, newSession);

    await sendSettingsMenu(ctx, newSession);
  });

  // Меню настроек
  async function sendSettingsMenu(ctx: any, session: UserSession) {
    const platformNames: Record<Platform, string> = {
      youtube: 'YouTube 🔴',
      vk: 'ВКонтакте 🔵',
      dzen: 'Дзен 🟠',
      instagram: 'Instagram 🟣',
      unknown: 'Неизвестно',
    };

    const modeLabel =
      session.mode === 'first_wins'
        ? '<b>Засчитывать только 1-й комментарий</b> (дубли отсеиваются)'
        : '<b>Дисквалификация нарушителей</b>';

    const repliesLabel = session.includeReplies
      ? '<b>Включая ответы в ветках</b>'
      : '<b>Только основные комменты (без веток)</b>';

    let keywordDesc = 'Все комментарии (без фильтрации по словам)';
    if (session.keywords && session.keywords.length > 0) {
      const wordsPreview =
        session.keywords.length <= 3
          ? session.keywords.map((k) => `«${k}»`).join(', ')
          : session.keywords.slice(0, 3).map((k) => `«${k}»`).join(', ') + ' и др.';

      keywordDesc =
        session.keywordMatchType === 'exact'
          ? `Строго одно из слов: ${wordsPreview} (без лишнего текста)`
          : `Любое из слов: ${wordsPreview} (в любом месте фразы)`;
    }

    const keywordBtnText =
      session.keywords && session.keywords.length > 0
        ? `🔤 Слова (${session.keywords.length} шт.): сбросить`
        : `🔤 Задать кодовые слова (в столбик)`;

    const keyboard = new InlineKeyboard()
      .text(
        session.mode === 'first_wins' ? '🟢 1-й коммент (выбран)' : '⚪ Засчитать 1-й',
        'mode_first_wins'
      )
      .text(
        session.mode === 'disqualify' ? '🔴 Дисквалификация (выбрана)' : '⚪ Дисквалификация',
        'mode_disqualify'
      )
      .row()
      .text(
        session.includeReplies ? '💬 Включая ответы в ветках' : '❌ Только основные (без веток)',
        'toggle_replies'
      )
      .row()
      .text(keywordBtnText, 'prompt_keyword');

    if (session.keywords && session.keywords.length > 0) {
      keyboard.row().text(
        session.keywordMatchType === 'exact'
          ? '🎯 Режим: Строго точные слова'
          : '🔹 Режим: В любом месте фразы',
        'toggle_match_type'
      );
    }

    keyboard.row().text('🚀 Начать сбор и присвоение номеров', 'start_scraping');

    const msg =
      `🔗 <b>Ссылка принята:</b> ${platformNames[session.platform]}\n\n` +
      `⚙️ <b>Параметры проверки:</b>\n` +
      `• Повторы: ${modeLabel}\n` +
      `• Ветки: ${repliesLabel}\n` +
      `• Фильтр слов: ${keywordDesc}\n\n` +
      `Настройте параметры кнопками ниже или нажмите <b>«Начать сбор»</b>:`;

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  }

  // Переключение типа совпадения слов
  bot.callbackQuery('toggle_match_type', async (ctx) => {
    const session = sessions.get(ctx.chat?.id || 0);
    if (!session) return safeAnswerCallback(ctx, 'Сессия устарела, отправьте ссылку заново.');

    session.keywordMatchType = session.keywordMatchType === 'exact' ? 'contains' : 'exact';
    const statusText =
      session.keywordMatchType === 'exact'
        ? 'Режим: Строго точные слова (без лишнего текста)'
        : 'Режим: В любом месте фразы';

    await safeAnswerCallback(ctx, statusText);
    await updateSettingsMessage(ctx, session);
  });

  // Колбэк запроса ключевых слов
  bot.callbackQuery('prompt_keyword', async (ctx) => {
    const session = sessions.get(ctx.chat?.id || 0);
    if (!session) {
      await safeAnswerCallback(ctx, 'Сессия устарела, отправьте ссылку заново.');
      return;
    }

    if (session.keywords && session.keywords.length > 0) {
      session.keywords = undefined;
      await safeAnswerCallback(ctx, 'Фильтр по словам сброшен');
      await updateSettingsMessage(ctx, session);
      return;
    }

    session.awaitingKeywordInput = true;
    await safeAnswerCallback(ctx);
    await ctx.reply(
      '✍️ <b>Отправьте кодовые слова — каждое с новой строки:</b>\n\n' +
        '<code>Easy\nУчаствую\nХочу приз\n+</code>\n\n' +
        '<i>(Или отправьте 0 для отмены)</i>',
      { parse_mode: 'HTML' }
    );
  });

  // Переключение режима отсева дубликатов
  bot.callbackQuery('mode_first_wins', async (ctx) => {
    const session = sessions.get(ctx.chat?.id || 0);
    if (!session) return safeAnswerCallback(ctx, 'Сессия устарела, отправьте ссылку заново.');

    session.mode = 'first_wins';
    await safeAnswerCallback(ctx, 'Режим: Засчитывать первый комментарий');
    await updateSettingsMessage(ctx, session);
  });

  bot.callbackQuery('mode_disqualify', async (ctx) => {
    const session = sessions.get(ctx.chat?.id || 0);
    if (!session) return safeAnswerCallback(ctx, 'Сессия устарела, отправьте ссылку заново.');

    session.mode = 'disqualify';
    await safeAnswerCallback(ctx, 'Режим: Полная дисквалификация нарушителей');
    await updateSettingsMessage(ctx, session);
  });

  bot.callbackQuery('toggle_replies', async (ctx) => {
    const session = sessions.get(ctx.chat?.id || 0);
    if (!session) return safeAnswerCallback(ctx, 'Сессия устарела, отправьте ссылку заново.');

    session.includeReplies = !session.includeReplies;
    await safeAnswerCallback(
      ctx,
      session.includeReplies ? 'Ответы в ветках: Включены' : 'Ответы в ветках: Отключены'
    );
    await updateSettingsMessage(ctx, session);
  });

  async function updateSettingsMessage(ctx: any, session: UserSession) {
    const modeLabel =
      session.mode === 'first_wins'
        ? '<b>Засчитывать только 1-й комментарий</b> (дубли отсеиваются)'
        : '<b>Дисквалификация нарушителей</b>';

    const repliesLabel = session.includeReplies
      ? '<b>Включая ответы в ветках</b>'
      : '<b>Только основные комменты (без веток)</b>';

    let keywordDesc = 'Все комментарии (без фильтрации по словам)';
    if (session.keywords && session.keywords.length > 0) {
      const wordsPreview =
        session.keywords.length <= 3
          ? session.keywords.map((k) => `«${k}»`).join(', ')
          : session.keywords.slice(0, 3).map((k) => `«${k}»`).join(', ') + ' и др.';

      keywordDesc =
        session.keywordMatchType === 'exact'
          ? `Строго одно из слов: ${wordsPreview} (без лишнего текста)`
          : `Любое из слов: ${wordsPreview} (в любом месте фразы)`;
    }

    const keywordBtnText =
      session.keywords && session.keywords.length > 0
        ? `🔤 Слова (${session.keywords.length} шт.): сбросить`
        : `🔤 Задать кодовые слова (в столбик)`;

    const keyboard = new InlineKeyboard()
      .text(
        session.mode === 'first_wins' ? '🟢 1-й коммент (выбран)' : '⚪ Засчитать 1-й',
        'mode_first_wins'
      )
      .text(
        session.mode === 'disqualify' ? '🔴 Дисквалификация (выбрана)' : '⚪ Дисквалификация',
        'mode_disqualify'
      )
      .row()
      .text(
        session.includeReplies ? '💬 Включая ответы в ветках' : '❌ Только основные (без веток)',
        'toggle_replies'
      )
      .row()
      .text(keywordBtnText, 'prompt_keyword');

    if (session.keywords && session.keywords.length > 0) {
      keyboard.row().text(
        session.keywordMatchType === 'exact'
          ? '🎯 Режим: Строго точные слова'
          : '🔹 Режим: В любом месте фразы',
        'toggle_match_type'
      );
    }

    keyboard.row().text('🚀 Начать сбор и присвоение номеров', 'start_scraping');

    const platformNames: Record<Platform, string> = {
      youtube: 'YouTube 🔴',
      vk: 'ВКонтакте 🔵',
      dzen: 'Дзен 🟠',
      instagram: 'Instagram 🟣',
      unknown: 'Неизвестно',
    };

    const text =
      `🔗 <b>Ссылка принята:</b> ${platformNames[session.platform]}\n\n` +
      `⚙️ <b>Параметры проверки:</b>\n` +
      `• Повторы: ${modeLabel}\n` +
      `• Ветки: ${repliesLabel}\n` +
      `• Фильтр слов: ${keywordDesc}\n\n` +
      `Настройте параметры кнопками ниже или нажмите <b>«Начать сбор»</b>:`;

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
    } catch {}
  }

  // Запуск сбора и обработки
  bot.callbackQuery('start_scraping', async (ctx) => {
    const session = sessions.get(ctx.chat?.id || 0);
    if (!session) {
      await safeAnswerCallback(ctx, 'Сессия устарела, отправьте ссылку заново.');
      return;
    }

    if (session.isScraping) {
      await safeAnswerCallback(
        ctx,
        '⚠️ Сбор комментариев уже запущен! Пожалуйста, дождитесь окончания процесса.'
      );
      return;
    }

    // 🔒 Синхронная установка блокировки сессии ДО любых асинхронных вызовов (устранение TOCTOU)
    session.isScraping = true;

    let statusMsg: any = null;

    try {
      await safeAnswerCallback(ctx);

      statusMsg = await ctx.reply('⏳ <b>Инициализация подключения к платформе...</b>', {
        parse_mode: 'HTML',
      });

      let lastProgressUpdate = 0;
      const onProgress = async (count: number) => {
        const now = Date.now();
        if (now - lastProgressUpdate > 2500 && statusMsg) {
          lastProgressUpdate = now;
          try {
            await ctx.api.editMessageText(
              ctx.chat!.id,
              statusMsg.message_id,
              `⏳ <b>Выполняется сбор комментариев...</b>\nСобрано: <b>${count}</b> шт.`,
              { parse_mode: 'HTML' }
            );
          } catch {}
        }
      };

      let rawComments: RawComment[] = [];

      console.log(`[BOT] Старт сбора: URL=${session.url}, платформа=${session.platform}`);

      if (session.platform === 'youtube') {
        rawComments = await youtubeScraper.fetchComments(session.url, {
          includeReplies: session.includeReplies,
          keywords: session.keywords,
          onProgress,
        });
      } else if (session.platform === 'vk') {
        rawComments = await vkScraper.fetchComments(session.url, {
          includeReplies: session.includeReplies,
          keywords: session.keywords,
          onProgress,
        });
      } else if (session.platform === 'dzen') {
        rawComments = await dzenScraper.fetchComments(session.url, {
          includeReplies: session.includeReplies,
          keywords: session.keywords,
          onProgress,
        });
      } else if (session.platform === 'instagram') {
        rawComments = await instagramScraper.fetchComments(session.url, {
          includeReplies: session.includeReplies,
          keywords: session.keywords,
          onProgress,
        });
      }

      console.log(`[BOT] Собрано сырых комментариев: ${rawComments.length}`);

      if (rawComments.length === 0) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          'ℹ️ <b>Комментарии не найдены</b> или публикация закрыта настройками приватности.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `⚙️ <i>Обработка комментариев (${rawComments.length} шт.), фильтрация и присвоение номеров...</i>`,
        { parse_mode: 'HTML' }
      );

      // 1. Дедупликация, проверка списка ключевых слов и нумерация
      const deduplicationResult = deduplicator.processComments(
        rawComments,
        session.mode,
        session.includeReplies,
        session.keywords,
        session.keywordMatchType
      );
      session.lastResult = deduplicationResult;

      // 2. Генерация Excel-отчета
      const excelFilePath = await excelService.generateReport(deduplicationResult, session.url);
      session.lastReportPath = excelFilePath;

      // 3. Отправляем документ Excel пользователю
      let wordCaption = '';
      if (session.keywords && session.keywords.length > 0) {
        const wordsStr = session.keywords.slice(0, 3).join(', ');
        wordCaption =
          session.keywordMatchType === 'exact'
            ? ` (строго слова: ${wordsStr})`
            : ` (содержит слова: ${wordsStr})`;
      }

      await ctx.replyWithDocument(new InputFile(excelFilePath), {
        caption: `📊 Список участников с номерами (1...${deduplicationResult.participants.length})${wordCaption}`,
      });

      // 4. Формируем итоговую статистику
      let wordStat = '';
      if (session.keywords && session.keywords.length > 0) {
        const typeStr =
          session.keywordMatchType === 'exact'
            ? 'Строго точные слова'
            : 'В любом месте фразы';
        const wordsList = session.keywords.map((w) => `«${w}»`).join(', ');
        wordStat = `• Список кодовых слов (${session.keywords.length} шт.): ${wordsList} (<i>${typeStr}</i>)\n`;
      }

      const summaryText =
        `🎉 <b>Обработка успешно завершена!</b>\n\n` +
        `📈 <b>Итоги розыгрыша:</b>\n` +
        `• Всего комментариев проверено: <b>${deduplicationResult.totalRawComments}</b>\n` +
        `• Уникальных пользователей: <b>${deduplicationResult.uniqueAuthorsCount}</b>\n` +
        wordStat +
        `• <b>Валидных участников (получили номера): ${deduplicationResult.participants.length}</b>\n` +
        `• Отсеяно дубликатов / не по правилам: <b>${deduplicationResult.duplicates.length}</b>\n\n` +
        `📋 <i>Подробная таблица с номерами и отчетом по исключенным прикреплена выше.</i>\n\n` +
        `Вы можете определить победителя прямо сейчас:`;

      const winnerKeyboard = new InlineKeyboard().text(
        '🎲 Выбрать случайного победителя',
        'pick_random_winner'
      );

      await ctx.reply(summaryText, {
        parse_mode: 'HTML',
        reply_markup: winnerKeyboard,
      });

      try {
        if (statusMsg && ctx.chat) {
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id);
        }
      } catch {}
    } catch (error: any) {
      console.error('Ошибка при обработке:', error);
      const errorCode = (error as any)?.code || (error as any)?.error_code;
      let errorMessage = '❌ Произошла ошибка при сборе данных. Попробуйте позже или проверьте ссылку.';

      if (errorCode === 29 || errorCode === 'RATE_LIMIT' || error?.message?.includes('Rate limit reached')) {
        errorMessage = '⚠️ <b>Лимит запросов к VK API исчерпан</b> на сегодня. Платформа VK временно ограничивает выгрузку. Пожалуйста, повторите сбор завтра.';
      } else if (errorCode === 15 || errorCode === 'ACCESS_DENIED') {
        errorMessage = '🔒 <b>Ошибка доступа</b>: запись или сообщество закрыто, либо доступ к комментариям ограничен.';
      } else if (errorCode === 212 || errorCode === 'ACCESS_TO_COMMENTS_DENIED') {
        errorMessage = '🚫 <b>Комментарии отключены</b> автором к этой публикации.';
      } else if (error?.message) {
        errorMessage += `\n\n<i>Детали: ${error.message}</i>`;
      }

      if (statusMsg && ctx.chat) {
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            errorMessage,
            { parse_mode: 'HTML' }
          );
        } catch {
          await ctx.reply(errorMessage, { parse_mode: 'HTML' });
        }
      } else {
        await ctx.reply(errorMessage, { parse_mode: 'HTML' });
      }
    } finally {
      session.isScraping = false;
    }
  });

  // Рандомайзер победителя
  bot.callbackQuery('pick_random_winner', async (ctx) => {
    const session = sessions.get(ctx.chat?.id || 0);
    if (!session || !session.lastResult || session.lastResult.participants.length === 0) {
      await safeAnswerCallback(ctx, 'Список участников пуст или сессия истекла. Запустите обработку заново.');
      return;
    }

    const participants = session.lastResult.participants;
    const randomIndex = Math.floor(Math.random() * participants.length);
    const winner = participants[randomIndex];

    await safeAnswerCallback(ctx, `🎉 Выбран победитель №${winner.number}!`);

    const winnerText =
      `🏆 <b>ПОБЕДИТЕЛЬ РОЗЫГРЫША!</b>\n\n` +
      `🎯 <b>Счастливый номер:</b> №${winner.number}\n` +
      `👤 <b>Участник:</b> ${winner.username}\n` +
      `🔗 <b>Профиль:</b> ${winner.profileUrl || 'не указан'}\n` +
      `💬 <b>Комментарий:</b> «<i>${winner.commentText}</i>»\n` +
      `📅 <b>Дата публикации:</b> ${winner.createdAt.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
      })}\n\n` +
      `<i>(Победитель выбран случайно из диапазона 1...${participants.length})</i>`;

    const nextKeyboard = new InlineKeyboard().text(
      '🔄 Выбрать другого (переиграть)',
      'pick_random_winner'
    );

    await ctx.reply(winnerText, {
      parse_mode: 'HTML',
      reply_markup: nextKeyboard,
    });
  });

  return bot;
}
