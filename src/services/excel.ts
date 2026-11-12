import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs/promises';
import { DeduplicationResult } from '../types.js';
import { config } from '../config.js';

export class ExcelService {
  /**
   * Генерирует стилизованный Excel-файл (.xlsx) с двумя листами:
   * 1. Участники с присвоенными номерами
   * 2. Исключенные дубликаты / нарушители / не прошедшие по словам
   */
  public async generateReport(result: DeduplicationResult, postUrl: string): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Giveaway Contest Bot';
    workbook.created = new Date();

    // ==========================================
    // ЛИСТ 1: УЧАСТНИКИ РОЗЫГРЫША
    // ==========================================
    let sheetTitle = 'Участники розыгрыша';
    if (result.keywordFilter && result.keywordFilter.length > 0) {
      const wordsPreview = result.keywordFilter.slice(0, 2).join(', ');
      sheetTitle = `Участники (${wordsPreview}${result.keywordFilter.length > 2 ? '...' : ''})`;
    }

    // Лимит длины названия листа в Excel — 31 символ
    if (sheetTitle.length > 31) {
      sheetTitle = sheetTitle.slice(0, 28) + '...';
    }

    const sheetParticipants = workbook.addWorksheet(sheetTitle, {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: 'FF107C41' } }, // Зеленый цвет вкладки Excel
    });

    sheetParticipants.columns = [
      { header: '№ п/п', key: 'number', width: 10 },
      { header: 'Имя / Никнейм', key: 'username', width: 25 },
      { header: 'Ссылка на профиль', key: 'profileUrl', width: 35 },
      { header: 'Текст комментария', key: 'commentText', width: 55 },
      { header: 'Дата и время', key: 'createdAt', width: 22 },
    ];

    // Оформление шапки Листа 1
    const headerRow1 = sheetParticipants.getRow(1);
    headerRow1.height = 28;
    headerRow1.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF107C41' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'medium' },
        right: { style: 'thin' },
      };
    });

    // Заполнение данными Листа 1
    for (const participant of result.participants) {
      const row = sheetParticipants.addRow({
        number: participant.number,
        username: participant.username,
        profileUrl: participant.profileUrl || '—',
        commentText: participant.commentText,
        createdAt: participant.createdAt.toLocaleString('ru-RU', {
          timeZone: 'Europe/Moscow',
        }),
      });

      row.height = 22;
      row.alignment = { vertical: 'middle' };

      row.getCell('number').alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell('createdAt').alignment = { vertical: 'middle', horizontal: 'center' };

      if (participant.profileUrl && participant.profileUrl.startsWith('http')) {
        row.getCell('profileUrl').value = {
          text: participant.profileUrl,
          hyperlink: participant.profileUrl,
        };
        row.getCell('profileUrl').font = { color: { argb: 'FF0066CC' }, underline: true };
      }

      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        };
      });
    }

    // ==========================================
    // ЛИСТ 2: ИСКЛЮЧЕННЫЕ ДУБЛИКАТЫ И СПАМ
    // ==========================================
    const sheetDuplicates = workbook.addWorksheet('Исключенные повторы', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: 'FFD83B01' } },
    });

    sheetDuplicates.columns = [
      { header: '№', key: 'idx', width: 8 },
      { header: 'Имя / Никнейм', key: 'username', width: 25 },
      { header: 'Ссылка на профиль', key: 'profileUrl', width: 35 },
      { header: 'Всего коммент.', key: 'total', width: 15 },
      { header: 'Причина отсева', key: 'reason', width: 45 },
      { header: 'Тексты комментариев', key: 'commentsHistory', width: 60 },
    ];

    const headerRow2 = sheetDuplicates.getRow(1);
    headerRow2.height = 28;
    headerRow2.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD83B01' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'medium' },
        right: { style: 'thin' },
      };
    });

    let dupIndex = 1;
    for (const dup of result.duplicates) {
      const history = dup.comments.map((c, i) => `[${i + 1}] ${c.text}`).join(' | ');
      const row = sheetDuplicates.addRow({
        idx: dupIndex++,
        username: dup.username,
        profileUrl: dup.profileUrl || '—',
        total: dup.totalComments,
        reason: dup.reason,
        commentsHistory: history,
      });

      row.height = 22;
      row.alignment = { vertical: 'middle' };
      row.getCell('idx').alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell('total').alignment = { vertical: 'middle', horizontal: 'center' };

      if (dup.profileUrl && dup.profileUrl.startsWith('http')) {
        row.getCell('profileUrl').value = {
          text: dup.profileUrl,
          hyperlink: dup.profileUrl,
        };
        row.getCell('profileUrl').font = { color: { argb: 'FF0066CC' }, underline: true };
      }

      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        };
      });
    }

    const outputDir = config.downloadsDir;
    await fs.mkdir(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sanitizedDomain = postUrl.replace(/^https?:\/\//, '').split('/')[0].replace(/[^a-zA-Z0-9]/g, '_');
    const filePath = path.join(outputDir, `giveaway_${sanitizedDomain}_${timestamp}.xlsx`);

    await workbook.xlsx.writeFile(filePath);
    return filePath;
  }
}

export const excelService = new ExcelService();
