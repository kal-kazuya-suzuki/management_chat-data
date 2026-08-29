/**
 * npm run rooms — 参加中のルーム一覧（room_id / 名前 / 種別）を表示する。
 * ルームIDを調べるためだけにブラウザを開かなくて済むようにするコマンド。
 *
 * オプション:
 *   --type=group|direct|my   種別で絞り込む
 *   --search=<文字列>        ルーム名の部分一致で絞り込む
 *   --json                   JSON で出力する
 */
import { loadConfig } from '../config.js';
import { ChatworkClient } from '../chatwork/client.js';
import type { ChatworkRoom } from '../chatwork/types.js';
import * as log from '../util/log.js';

const TYPE_LABEL: Record<string, string> = {
  my: 'マイチャット',
  direct: 'ダイレクト',
  group: 'グループ',
};

/** 全角文字を2文字幅として数え、表を崩さないための表示幅計算。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += isWide ? 2 : 1;
  }
  return width;
}

export function padRight(text: string, width: number): string {
  const padding = Math.max(0, width - displayWidth(text));
  return text + ' '.repeat(padding);
}

export function formatRoomsTable(rooms: readonly ChatworkRoom[]): string {
  if (rooms.length === 0) return '該当するルームはありませんでした。';

  const rows = rooms.map((room) => ({
    id: String(room.room_id),
    type: TYPE_LABEL[room.type] ?? room.type,
    name: room.name,
    messages: String(room.message_num ?? 0),
  }));

  const idWidth = Math.max(8, ...rows.map((row) => displayWidth(row.id)));
  const typeWidth = Math.max(4, ...rows.map((row) => displayWidth(row.type)));
  const countWidth = Math.max(4, ...rows.map((row) => displayWidth(row.messages)));

  const lines = [
    `${padRight('room_id', idWidth)}  ${padRight('種別', typeWidth)}  ${padRight('件数', countWidth)}  ルーム名`,
    `${'-'.repeat(idWidth)}  ${'-'.repeat(typeWidth)}  ${'-'.repeat(countWidth)}  ${'-'.repeat(20)}`,
  ];
  for (const row of rows) {
    lines.push(
      `${padRight(row.id, idWidth)}  ${padRight(row.type, typeWidth)}  ${padRight(row.messages, countWidth)}  ${row.name}`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const typeFilter = readOption(argv, 'type');
  const search = readOption(argv, 'search');

  const config = loadConfig();
  const client = new ChatworkClient({
    token: config.token,
    baseUrl: config.baseUrl,
    rateLimit: config.rateLimit,
    rateWindowSeconds: config.rateWindowSeconds,
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
  });

  let rooms = await client.getRooms();
  if (typeFilter) rooms = rooms.filter((room) => room.type === typeFilter);
  if (search) {
    const needle = search.toLowerCase();
    rooms = rooms.filter((room) => room.name.toLowerCase().includes(needle));
  }
  rooms = [...rooms].sort((a, b) => (b.last_update_time ?? 0) - (a.last_update_time ?? 0));

  if (asJson) {
    log.out(
      JSON.stringify(
        rooms.map((room) => ({
          room_id: String(room.room_id),
          name: room.name,
          type: room.type,
          message_num: room.message_num,
        })),
        null,
        2,
      ),
    );
    return;
  }

  log.out(formatRoomsTable(rooms));
  log.out('');
  log.out(`${rooms.length} 件（最終更新が新しい順）`);
  log.out('例: npm run export -- --room=<room_id> --from=2026-08-01 --to=2026-08-29');
}

function readOption(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token.startsWith(prefix)) return token.slice(prefix.length);
    if (token === `--${name}` && argv[i + 1] !== undefined) return argv[i + 1] as string;
  }
  return null;
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
