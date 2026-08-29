/** 出力ファイルの命名と書き出し。 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExportedMessage } from './record.js';

/** パス区切り・Windows で使えない文字・制御文字。 */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** ファイル名に使えない文字を落とす。 */
export function sanitizeForFilename(input: string, maxLength = 40): string {
  const cleaned = input
    .replace(UNSAFE_FILENAME_CHARS, '')
    // 半角・全角どちらの空白もアンダースコアにまとめる
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .trim();
  if (cleaned === '') return 'room';
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

export interface FileNameParts {
  roomId: string;
  roomName: string;
  from: string;
  to: string;
  mine: boolean;
  extension: 'json' | 'md';
}

/** 例: chatwork_123456789_サンプル株式会社_2026-08-01_2026-08-29_mine.md */
export function buildFileName(parts: FileNameParts): string {
  const segments = [
    'chatwork',
    parts.roomId,
    sanitizeForFilename(parts.roomName),
    parts.from,
    parts.to,
  ];
  if (parts.mine) segments.push('mine');
  return `${segments.join('_')}.${parts.extension}`;
}

export async function writeOutput(outDir: string, fileName: string, content: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, fileName);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

export function renderJson(messages: ExportedMessage[]): string {
  return `${JSON.stringify(messages, null, 2)}\n`;
}
