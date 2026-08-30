/**
 * CLI 引数のパース。外部ライブラリを使わず、テストしやすい純粋関数として実装する。
 */
import { parseDateOnly, parseTzOffset, shiftDays, todayInTz } from './util/date.js';

export type OutputFormat = 'json' | 'md' | 'both';

export interface ExportArgs {
  /** 対象ルームID。--all の場合は空配列 */
  roomIds: string[];
  /** 参加中の全ルームを対象にする */
  all: boolean;
  from: string;
  to: string;
  format: OutputFormat;
  mine: boolean;
  minLength: number;
  outDir: string;
  tzOffsetMinutes: number;
  maxPages: number;
  verbose: boolean;
  help: boolean;
}

export interface ParseContext {
  /** 既定値の計算に使う「今日」。省略時は tz における現在日 */
  today?: string;
  /** 環境変数由来の既定値 */
  defaultTz?: string;
  defaultOutDir?: string;
}

/** 既定の取得期間（日数）。--from 省略時は「今日を含む直近 N 日」。 */
export const DEFAULT_RANGE_DAYS = 30;
export const DEFAULT_MIN_LENGTH = 20;
export const DEFAULT_OUT_DIR = './exports';
export const DEFAULT_MAX_PAGES = 200;

const BOOLEAN_FLAGS = new Set([
  'all',
  'mine',
  'verbose',
  'help',
  'no-threads',
  'include-system',
  'no-bots',
]);
const KNOWN_FLAGS = new Set([
  'room',
  'rooms',
  'all',
  'from',
  'to',
  'format',
  'mine',
  'min-length',
  'out',
  'tz',
  'max-pages',
  'verbose',
  'help',
]);
/** Slack 版で追加になるフラグ */
const SLACK_FLAGS = new Set([
  'channel',
  'channels',
  'all',
  'from',
  'to',
  'format',
  'mine',
  'min-length',
  'out',
  'tz',
  'max-pages',
  'max-threads',
  'page-limit',
  'no-threads',
  'include-system',
  'no-bots',
  'verbose',
  'help',
]);

export class ArgError extends Error {}

interface RawArgs {
  values: Map<string, string[]>;
  positionals: string[];
}

/** --key=value / --key value / --key(boolean) / -h をパースする。 */
export function tokenize(argv: readonly string[], knownFlags: ReadonlySet<string> = KNOWN_FLAGS): RawArgs {
  const values = new Map<string, string[]>();
  const positionals: string[] = [];

  const push = (key: string, value: string): void => {
    const list = values.get(key);
    if (list) list.push(value);
    else values.set(key, [value]);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === '-h') {
      push('help', 'true');
      continue;
    }
    if (token === '-v') {
      push('verbose', 'true');
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);

    if (!knownFlags.has(key)) {
      throw new ArgError(`不明なオプションです: --${key}`);
    }

    if (eq !== -1) {
      push(key, body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      push(key, 'true');
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new ArgError(`--${key} には値が必要です`);
    }
    push(key, next);
    i += 1;
  }

  return { values, positionals };
}

function single(raw: RawArgs, key: string): string | undefined {
  const list = raw.values.get(key);
  if (!list || list.length === 0) return undefined;
  return list[list.length - 1];
}

function boolean(raw: RawArgs, key: string): boolean {
  return raw.values.has(key);
}

/** "123, 456\n789" のような入力を room_id の配列にする。 */
export function parseRoomIds(inputs: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    for (const piece of input.split(/[,\s]+/)) {
      const id = piece.trim();
      if (!id) continue;
      if (!/^\d+$/.test(id)) {
        throw new ArgError(`room_id は数字で指定してください: "${id}"`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function parseFormat(value: string | undefined): OutputFormat {
  if (value === undefined) return 'both';
  if (value === 'json' || value === 'md' || value === 'both') return value;
  throw new ArgError(`--format は json / md / both のいずれかです: "${value}"`);
}

function parseNonNegativeInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new ArgError(`${flag} は 0 以上の整数で指定してください: "${value}"`);
  }
  return Number(value.trim());
}

export function parseExportArgs(argv: readonly string[], context: ParseContext = {}): ExportArgs {
  const raw = tokenize(argv);

  if (raw.positionals.length > 0) {
    throw new ArgError(
      `オプション以外の引数は受け付けません: ${raw.positionals.join(' ')}\n（--room=123456789 のように指定してください）`,
    );
  }

  const help = boolean(raw, 'help');
  const tzOffsetMinutes = parseTzOffset(single(raw, 'tz') ?? context.defaultTz ?? '+09:00');
  const today = context.today ?? todayInTz(tzOffsetMinutes);

  const all = boolean(raw, 'all');
  const roomInputs = [...(raw.values.get('room') ?? []), ...(raw.values.get('rooms') ?? [])];
  const roomIds = parseRoomIds(roomInputs);

  if (!help) {
    if (!all && roomIds.length === 0) {
      throw new ArgError(
        '--room が指定されていません。\n' +
          '  対象ルームは必須です（全ルーム一括は事故のもとなので既定では実行しません）。\n' +
          '  例: npm run export -- --room=123456789 --from=2026-08-01 --to=2026-08-29\n' +
          '  ルームIDは `npm run rooms` で確認できます。\n' +
          '  全ルームを対象にしたい場合は --all を明示してください。',
      );
    }
    if (all && roomIds.length > 0) {
      throw new ArgError('--all と --room は同時に指定できません。');
    }
  }

  const to = single(raw, 'to') ?? today;
  const from = single(raw, 'from') ?? shiftDays(to, -(DEFAULT_RANGE_DAYS - 1));

  // 形式チェック（不正な日付はここで弾く）
  parseDateOnly(from);
  parseDateOnly(to);
  if (from > to) {
    throw new ArgError(`--from が --to より後になっています: ${from} > ${to}`);
  }

  const minLength = parseNonNegativeInt(single(raw, 'min-length'), DEFAULT_MIN_LENGTH, '--min-length');
  const maxPages = parseNonNegativeInt(single(raw, 'max-pages'), DEFAULT_MAX_PAGES, '--max-pages');
  if (maxPages < 1) {
    throw new ArgError('--max-pages は 1 以上で指定してください。');
  }

  return {
    roomIds,
    all,
    from,
    to,
    format: parseFormat(single(raw, 'format')),
    mine: boolean(raw, 'mine'),
    minLength,
    outDir: single(raw, 'out') ?? context.defaultOutDir ?? DEFAULT_OUT_DIR,
    tzOffsetMinutes,
    maxPages,
    verbose: boolean(raw, 'verbose'),
    help,
  };
}

export const EXPORT_USAGE = `
Chatwork の会話を期間とルームを指定してエクスポートします。

使い方:
  npm run export -- --room=<room_id[,room_id...]> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [options]

必須:
  --room=<ids>        対象ルームID。カンマ区切りで複数指定可。
                      （--all を明示しない限り必須。全ルーム一括は事故防止のため既定では行いません）

オプション:
  --all               参加中の全ルームを対象にする（--room とは併用不可）
  --from=YYYY-MM-DD   期間の開始日（含む）。既定: --to の ${DEFAULT_RANGE_DAYS - 1} 日前（＝今日を含む直近${DEFAULT_RANGE_DAYS}日）
  --to=YYYY-MM-DD     期間の終了日（含む）。既定: 今日
  --format=json|md|both  出力形式。既定: both
  --mine              自分の発言のみを出力（Markdown には直前の相手の発言も併記）
  --min-length=N      --mine のとき、N 文字未満の自分の発言を除外。既定: ${DEFAULT_MIN_LENGTH}
  --out=<dir>         出力先ディレクトリ。既定: ${DEFAULT_OUT_DIR}
  --tz=+09:00         日付の解釈に使うタイムゾーン。既定: +09:00 (JST)
  --max-pages=N       1ルームあたりの最大取得ページ数（1ページ100件）。既定: ${DEFAULT_MAX_PAGES}
  --verbose, -v       詳細ログを出す
  --help, -h          このヘルプを表示

例:
  npm run export -- --room=123456789 --from=2026-08-01 --to=2026-08-29
  npm run export -- --room=123456789,987654321 --format=md
  npm run export -- --room=123456789 --mine --min-length=30 --format=md
`.trim();

// ============================================================
// Slack 版
// ============================================================

export interface SlackExportArgs {
  /** 対象チャンネル。ID（C/G/D で始まる）か、# 付き・無しのチャンネル名 */
  channels: string[];
  all: boolean;
  from: string;
  to: string;
  format: OutputFormat;
  mine: boolean;
  minLength: number;
  outDir: string;
  tzOffsetMinutes: number;
  maxPages: number;
  maxThreads: number;
  pageLimit: number;
  /** スレッドの返信も取得するか */
  includeThreads: boolean;
  /** 参加・退出などのシステムメッセージを含めるか */
  includeSystem: boolean;
  /** Bot の発言を含めるか */
  includeBots: boolean;
  verbose: boolean;
  help: boolean;
}

export const DEFAULT_PAGE_LIMIT = 200;
export const DEFAULT_MAX_THREADS = 1000;
export const DEFAULT_SLACK_MAX_PAGES = 500;

/**
 * チャンネルIDの形（C=パブリック/プライベート, G=旧プライベート, D=DM）。
 * Slack のチャンネル**名**は小文字しか使えないので、大文字であることを ID の判別に使う
 * （小文字化して判定すると "general" が ID と誤認される）。
 */
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{6,}$/;

/** ID かチャンネル名かを判定する。大文字であることが条件。 */
export function isChannelId(value: string): boolean {
  return CHANNEL_ID_RE.test(value);
}

/** "C123, #general random" のような入力をチャンネル指定の配列にする。 */
export function parseChannelRefs(inputs: readonly string[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    for (const piece of input.split(/[,\s]+/)) {
      const raw = piece.trim();
      if (!raw) continue;
      const ref = raw.startsWith('#') ? raw.slice(1) : raw;
      if (!ref) continue;
      // ID はそのまま（大文字）。名前は Slack の規則に合わせて小文字に揃える
      const normalized = isChannelId(ref) ? ref : ref.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        refs.push(normalized);
      }
    }
  }
  return refs;
}

export function parseSlackExportArgs(
  argv: readonly string[],
  context: ParseContext = {},
): SlackExportArgs {
  const raw = tokenize(argv, SLACK_FLAGS);

  if (raw.positionals.length > 0) {
    throw new ArgError(
      `オプション以外の引数は受け付けません: ${raw.positionals.join(' ')}\n（--channel=C0123ABCD のように指定してください）`,
    );
  }

  const help = boolean(raw, 'help');
  const tzOffsetMinutes = parseTzOffset(single(raw, 'tz') ?? context.defaultTz ?? '+09:00');
  const today = context.today ?? todayInTz(tzOffsetMinutes);

  const all = boolean(raw, 'all');
  const channels = parseChannelRefs([
    ...(raw.values.get('channel') ?? []),
    ...(raw.values.get('channels') ?? []),
  ]);

  if (!help) {
    if (!all && channels.length === 0) {
      throw new ArgError(
        '--channel が指定されていません。\n' +
          '  対象チャンネルは必須です（全チャンネル一括は事故のもとなので既定では実行しません）。\n' +
          '  例: npm run export:slack -- --channel=C0123ABCD --from=2026-07-01\n' +
          '  チャンネルIDは `npm run channels` で確認できます（#general のような名前でも指定できます）。\n' +
          '  全チャンネルを対象にしたい場合は --all を明示してください。',
      );
    }
    if (all && channels.length > 0) {
      throw new ArgError('--all と --channel は同時に指定できません。');
    }
  }

  const to = single(raw, 'to') ?? today;
  const from = single(raw, 'from') ?? shiftDays(to, -(DEFAULT_RANGE_DAYS - 1));

  parseDateOnly(from);
  parseDateOnly(to);
  if (from > to) {
    throw new ArgError(`--from が --to より後になっています: ${from} > ${to}`);
  }

  const maxPages = parseNonNegativeInt(single(raw, 'max-pages'), DEFAULT_SLACK_MAX_PAGES, '--max-pages');
  if (maxPages < 1) throw new ArgError('--max-pages は 1 以上で指定してください。');

  const maxThreads = parseNonNegativeInt(single(raw, 'max-threads'), DEFAULT_MAX_THREADS, '--max-threads');

  const pageLimit = parseNonNegativeInt(single(raw, 'page-limit'), DEFAULT_PAGE_LIMIT, '--page-limit');
  if (pageLimit < 1 || pageLimit > 1000) {
    throw new ArgError('--page-limit は 1〜1000 の範囲で指定してください。');
  }

  return {
    channels,
    all,
    from,
    to,
    format: parseFormat(single(raw, 'format')),
    mine: boolean(raw, 'mine'),
    minLength: parseNonNegativeInt(single(raw, 'min-length'), DEFAULT_MIN_LENGTH, '--min-length'),
    outDir: single(raw, 'out') ?? context.defaultOutDir ?? DEFAULT_OUT_DIR,
    tzOffsetMinutes,
    maxPages,
    maxThreads,
    pageLimit,
    includeThreads: !boolean(raw, 'no-threads'),
    includeSystem: boolean(raw, 'include-system'),
    includeBots: !boolean(raw, 'no-bots'),
    verbose: boolean(raw, 'verbose'),
    help,
  };
}

export const SLACK_EXPORT_USAGE = `
Slack の会話を期間とチャンネルを指定してエクスポートします。

使い方:
  npm run export:slack -- --channel=<id|#名前[,...]> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [options]

必須:
  --channel=<refs>    対象チャンネル。IDでも #名前 でも可。カンマ区切りで複数指定可
                      （--all を明示しない限り必須）

オプション:
  --all               参加中の全チャンネルを対象にする（--channel とは併用不可）
  --from=YYYY-MM-DD   期間の開始日（含む）。既定: --to の ${DEFAULT_RANGE_DAYS - 1} 日前
  --to=YYYY-MM-DD     期間の終了日（含む）。既定: 今日
  --format=json|md|both  出力形式。既定: both
  --mine              自分の発言のみを出力（Markdown には直前の相手の発言も併記）
  --min-length=N      --mine のとき、N 文字未満の自分の発言を除外。既定: ${DEFAULT_MIN_LENGTH}
  --out=<dir>         出力先ディレクトリ。既定: ${DEFAULT_OUT_DIR}
  --tz=+09:00         日付の解釈に使うタイムゾーン。既定: +09:00 (JST)
  --no-threads        スレッドの返信を取得しない（リクエスト数を大きく減らせる）
  --include-system    「〜が参加しました」などのシステムメッセージも含める
  --no-bots           Bot の発言を除外する
  --page-limit=N      1リクエストの取得件数。既定: ${DEFAULT_PAGE_LIMIT}（最大1000）
  --max-pages=N       チャンネルあたりの最大ページ数。既定: ${DEFAULT_SLACK_MAX_PAGES}
  --max-threads=N     返信を取得するスレッド数の上限。既定: ${DEFAULT_MAX_THREADS}
  --verbose, -v       詳細ログを出す
  --help, -h          このヘルプを表示

例:
  npm run export:slack -- --channel=C0123ABCD --from=2026-07-01
  npm run export:slack -- --channel=#general,#random --format=md
  npm run export:slack -- --channel=C0123ABCD --mine --min-length=30 --no-threads
`.trim();
