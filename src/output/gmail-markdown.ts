/**
 * Gmail 用の Markdown 出力。
 *
 * チャットと違い、メールは「スレッド」がまとまりの単位なので、
 * スレッドごとに見出しを付けて区切る。
 */
import { buildMineBlocks, isoToDisplay, type MineMarkdownOptions } from './markdown.js';
import type { GmailExportedMessage } from './gmail-record.js';

export interface GmailMarkdownContext {
  mailbox: string;
  from: string;
  to: string;
  tzLabel: string;
  generatedAt: string;
  /** 実際に使った検索クエリ */
  query?: string;
  warnings?: string[];
  notes?: string[];
}

const CONFIDENTIAL_NOTE =
  '> **取り扱い注意**: このファイルには取引先とのやり取りが含まれます。共有・アップロード先に注意してください。';

const EMPTY_BODY = '（本文なし／添付のみなど）';

function header(context: GmailMarkdownContext, title: string, extraLines: string[]): string[] {
  const lines = [
    `# ${title}`,
    '',
    `- メールボックス: ${context.mailbox}`,
    `- 期間: ${context.from} 〜 ${context.to} (${context.tzLabel})`,
    ...extraLines,
    ...(context.query ? [`- 検索クエリ: \`${context.query}\``] : []),
    `- 生成日時: ${context.generatedAt}`,
    '',
    CONFIDENTIAL_NOTE,
    '',
  ];
  if (context.warnings && context.warnings.length > 0) {
    lines.push('> **取得に関する警告**');
    for (const warning of context.warnings) lines.push(`> - ${warning}`);
    lines.push('');
  }
  if (context.notes && context.notes.length > 0) {
    lines.push('> **補足**');
    for (const note of context.notes) lines.push(`> - ${note}`);
    lines.push('');
  }
  lines.push('---', '');
  return lines;
}

function bodyBlock(message: GmailExportedMessage): string {
  const body = message.body_plain.trim();
  if (body !== '') return body;
  return message.files.length > 0 ? `${EMPTY_BODY}\n添付: ${message.files.join(', ')}` : EMPTY_BODY;
}

/** スレッドIDごとにまとめる（並び順は入力の順序を保つ）。 */
export function groupByThread(
  messages: readonly GmailExportedMessage[],
): Array<{ threadId: string; subject: string; messages: GmailExportedMessage[] }> {
  const groups = new Map<string, { threadId: string; subject: string; messages: GmailExportedMessage[] }>();
  for (const message of messages) {
    let group = groups.get(message.thread_id);
    if (!group) {
      group = { threadId: message.thread_id, subject: message.room_name, messages: [] };
      groups.set(message.thread_id, group);
    }
    group.messages.push(message);
  }
  return [...groups.values()];
}

/** スレッドごとに区切った通常の Markdown。 */
export function renderGmailMarkdown(
  messages: readonly GmailExportedMessage[],
  context: GmailMarkdownContext,
): string {
  const threads = groupByThread(messages);
  const lines = header(context, `Gmail — ${context.mailbox}`, [
    `- スレッド数: ${threads.length}`,
    `- メール数: ${messages.length}`,
  ]);

  if (messages.length === 0) {
    lines.push('この期間に該当するメールはありませんでした。', '');
    return lines.join('\n');
  }

  threads.forEach((thread, index) => {
    lines.push(`## ${index + 1}. ${thread.subject}`, '');
    lines.push(`（${thread.messages.length} 通 / thread_id: ${thread.threadId}）`, '');
    for (const message of thread.messages) {
      const marker = message.is_mine ? '自分' : message.account_name;
      lines.push(`**${isoToDisplay(message.send_time)} ${marker}:**`);
      if (message.files.length > 0) lines.push(`> 添付: ${message.files.join(', ')}`);
      lines.push('', bodyBlock(message), '');
    }
    lines.push('---', '');
  });

  return lines.join('\n');
}

/**
 * 自分が送信したメールを、直前の相手のメールとセットで並べた Markdown。
 * ブロックの組み立てはスレッド単位で行う（スレッドをまたいで相手のメールを
 * 拾ってしまうと、文脈が食い違うため）。
 */
export function renderGmailMineMarkdown(
  messages: readonly GmailExportedMessage[],
  context: GmailMarkdownContext,
  options: MineMarkdownOptions,
): string {
  const threads = groupByThread(messages);
  const sections: Array<{
    subject: string;
    blocks: ReturnType<typeof buildMineBlocks>;
  }> = [];

  for (const thread of threads) {
    const blocks = buildMineBlocks(thread.messages, options);
    if (blocks.length > 0) sections.push({ subject: thread.subject, blocks });
  }

  const total = sections.reduce(
    (sum, section) => sum + section.blocks.reduce((n, block) => n + block.mine.length, 0),
    0,
  );

  const lines = header(context, `Gmail — 自分の送信メール（文体サンプル）`, [
    `- 自分のアドレス: ${options.myAccountId}`,
    `- 抽出条件: 自分が送信したメールのうち ${options.minLength} 文字以上（引用・署名を除いた本文の文字数）`,
    `- スレッド数: ${sections.length}`,
    `- メール数: ${total}`,
  ]);

  if (sections.length === 0) {
    lines.push('この期間に該当する自分の送信メールはありませんでした。', '');
    return lines.join('\n');
  }

  sections.forEach((section, index) => {
    lines.push(`## ${index + 1}. ${section.subject}`, '');
    for (const block of section.blocks) {
      if (block.partner) {
        lines.push(`**相手 / ${isoToDisplay(block.partner.send_time)} ${block.partner.account_name}:**`, '');
        lines.push(quote(bodyBlock(block.partner as GmailExportedMessage)), '');
      } else {
        lines.push('**相手 / （こちらから送ったメール）**', '');
      }
      for (const mine of block.mine) {
        lines.push(`**自分 / ${isoToDisplay(mine.send_time)}:**`, '');
        lines.push(bodyBlock(mine as GmailExportedMessage), '');
      }
    }
    lines.push('---', '');
  });

  return lines.join('\n');
}

/** 自分が送信したメールだけを抽出する（JSON 出力用）。 */
export function filterMineGmail(
  messages: readonly GmailExportedMessage[],
  options: MineMarkdownOptions,
): GmailExportedMessage[] {
  return messages.filter(
    (message) => message.is_mine && message.body_plain.trim().length >= options.minLength,
  );
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}
