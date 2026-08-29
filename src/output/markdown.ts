/** Markdown 出力。ルームごとに1ファイル。 */
import type { ExportedMessage } from './record.js';

export interface MarkdownContext {
  roomId: string;
  roomName: string;
  from: string;
  to: string;
  tzLabel: string;
  generatedAt: string;
  /** message_id → 返信先の発言者名 */
  replyNames?: Map<string, string | null>;
  warnings?: string[];
}

const CONFIDENTIAL_NOTE =
  '> **取り扱い注意**: このファイルには取引先とのやり取りが含まれます。共有・アップロード先に注意してください。';

const EMPTY_BODY = '（本文なし／ファイル送信・システムメッセージなど）';

/** "2026-08-01T10:12:33+09:00" → "2026-08-01 10:12" */
export function isoToDisplay(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function header(context: MarkdownContext, title: string, extraLines: string[]): string[] {
  const lines = [
    `# ${title}`,
    '',
    `- room_id: ${context.roomId}`,
    `- 期間: ${context.from} 〜 ${context.to} (${context.tzLabel})`,
    ...extraLines,
    `- 生成日時: ${context.generatedAt}`,
    '',
    CONFIDENTIAL_NOTE,
    '',
  ];
  if (context.warnings && context.warnings.length > 0) {
    lines.push('> **取得に関する警告**');
    for (const warning of context.warnings) {
      lines.push(`> - ${warning}`);
    }
    lines.push('');
  }
  lines.push('---', '');
  return lines;
}

function bodyBlock(message: ExportedMessage): string {
  const body = message.body_plain.trim();
  return body === '' ? EMPTY_BODY : body;
}

function replyLine(message: ExportedMessage, context: MarkdownContext): string | null {
  if (!message.reply_to) return null;
  const name = context.replyNames?.get(message.message_id);
  return name ? `> ${name}さんの発言への返信` : '> 過去の発言への返信';
}

/** 通常の Markdown（時系列で「日時 発言者: 本文」）。 */
export function renderMarkdown(messages: ExportedMessage[], context: MarkdownContext): string {
  const lines = header(context, context.roomName, [`- 件数: ${messages.length}`]);

  if (messages.length === 0) {
    lines.push('この期間に該当するメッセージはありませんでした。', '');
    return lines.join('\n');
  }

  for (const message of messages) {
    lines.push(`**${isoToDisplay(message.send_time)} ${message.account_name}:**`);
    const reply = replyLine(message, context);
    if (reply) lines.push(reply, '');
    lines.push(bodyBlock(message), '');
  }

  return lines.join('\n');
}

export interface MineMarkdownOptions {
  myAccountId: string;
  minLength: number;
}

/** 自分の発言を、直前の相手の発言とセットで並べた Markdown（文体サンプル用）。 */
export function renderMineMarkdown(
  timeline: ExportedMessage[],
  context: MarkdownContext,
  options: MineMarkdownOptions,
): string {
  const blocks = buildMineBlocks(timeline, options);
  const total = blocks.reduce((sum, block) => sum + block.mine.length, 0);

  const lines = header(context, `${context.roomName} — 自分の発言（文体サンプル）`, [
    `- 自分の account_id: ${options.myAccountId}`,
    `- 抽出条件: 自分の発言のうち ${options.minLength} 文字以上（Chatwork記法を除去した本文の文字数）`,
    `- 件数: ${total}`,
  ]);

  if (blocks.length === 0) {
    lines.push('この期間に該当する自分の発言はありませんでした。', '');
    return lines.join('\n');
  }

  blocks.forEach((block, index) => {
    lines.push(`## ${index + 1}`, '');
    if (block.partner) {
      lines.push(`**相手 / ${isoToDisplay(block.partner.send_time)} ${block.partner.account_name}:**`, '');
      lines.push(quote(bodyBlock(block.partner)), '');
    } else {
      lines.push('**相手 / （直前の相手の発言なし）**', '');
    }
    for (const mine of block.mine) {
      lines.push(`**自分 / ${isoToDisplay(mine.send_time)}:**`, '');
      lines.push(bodyBlock(mine), '');
    }
  });

  return lines.join('\n');
}

export interface MineBlock {
  /** 直前の相手の発言（無ければ null） */
  partner: ExportedMessage | null;
  /** 連続する自分の発言（min-length で絞った後） */
  mine: ExportedMessage[];
}

/**
 * 時系列から「直前の相手の発言 + 連続する自分の発言」のブロックを組み立てる。
 * 自分の発言が連続する場合はまとめて1ブロックにする（同じ相手発言を何度も繰り返さないため）。
 */
export function buildMineBlocks(
  timeline: readonly ExportedMessage[],
  options: MineMarkdownOptions,
): MineBlock[] {
  const blocks: MineBlock[] = [];
  let lastPartner: ExportedMessage | null = null;
  let current: MineBlock | null = null;

  for (const message of timeline) {
    if (message.account_id === options.myAccountId) {
      if (!current) current = { partner: lastPartner, mine: [] };
      if (message.body_plain.trim().length >= options.minLength) {
        current.mine.push(message);
      }
      continue;
    }
    // 相手の発言でブロックが切れる
    if (current) {
      if (current.mine.length > 0) blocks.push(current);
      current = null;
    }
    lastPartner = message;
  }

  if (current && current.mine.length > 0) blocks.push(current);
  return blocks;
}

/** 自分の発言だけを抽出する（JSON 出力用。Markdown と同じ絞り込み条件）。 */
export function filterMine(
  timeline: readonly ExportedMessage[],
  options: MineMarkdownOptions,
): ExportedMessage[] {
  return timeline.filter(
    (message) =>
      message.account_id === options.myAccountId &&
      message.body_plain.trim().length >= options.minLength,
  );
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}
