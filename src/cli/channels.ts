/**
 * npm run channels — Slack のチャンネル一覧（ID / 名前 / 種別）を表示する。
 * チャンネルIDを調べるためだけにブラウザを開かなくて済むようにするコマンド。
 *
 * オプション:
 *   --search=<文字列>   チャンネル名の部分一致で絞り込む
 *   --types=<types>     conversations.list の types（既定 public_channel,private_channel）
 *   --member-only       自分が参加しているチャンネルだけ表示
 *   --include-archived  アーカイブ済みも含める
 *   --json              JSON で出力
 */
import { loadSlackConfig } from '../config.js';
import { SlackClient } from '../slack/client.js';
import { channelKind, type SlackChannel } from '../slack/types.js';
import * as log from '../util/log.js';
import { displayWidth, padRight } from '../util/table.js';

export function formatChannelsTable(channels: readonly SlackChannel[]): string {
  if (channels.length === 0) return '該当するチャンネルはありませんでした。';

  const rows = channels.map((channel) => ({
    id: channel.id,
    kind: channelKind(channel),
    member: channel.is_member ? '参加' : '',
    members: channel.num_members === undefined ? '' : String(channel.num_members),
    name: channel.name ?? '(名前なし)',
  }));

  const idWidth = Math.max(11, ...rows.map((row) => displayWidth(row.id)));
  const kindWidth = Math.max(8, ...rows.map((row) => displayWidth(row.kind)));
  const memberWidth = 4;
  const countWidth = Math.max(4, ...rows.map((row) => displayWidth(row.members)));

  const lines = [
    `${padRight('channel_id', idWidth)}  ${padRight('種別', kindWidth)}  ${padRight('参加', memberWidth)}  ${padRight('人数', countWidth)}  チャンネル名`,
    `${'-'.repeat(idWidth)}  ${'-'.repeat(kindWidth)}  ${'-'.repeat(memberWidth)}  ${'-'.repeat(countWidth)}  ${'-'.repeat(20)}`,
  ];
  for (const row of rows) {
    lines.push(
      `${padRight(row.id, idWidth)}  ${padRight(row.kind, kindWidth)}  ${padRight(row.member, memberWidth)}  ${padRight(row.members, countWidth)}  ${row.name}`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const memberOnly = argv.includes('--member-only');
  const includeArchived = argv.includes('--include-archived');
  const search = readOption(argv, 'search');
  const types = readOption(argv, 'types') ?? 'public_channel,private_channel';

  const config = loadSlackConfig();
  const client = new SlackClient({
    token: config.token,
    baseUrl: config.baseUrl,
    rateLimit: config.rateLimit,
    rateWindowSeconds: config.rateWindowSeconds,
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
  });

  let channels = await client.listChannels({ types, excludeArchived: !includeArchived });
  if (memberOnly) channels = channels.filter((channel) => channel.is_member);
  if (search) {
    const needle = search.toLowerCase();
    channels = channels.filter((channel) => (channel.name ?? '').toLowerCase().includes(needle));
  }
  channels = [...channels].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  if (asJson) {
    log.out(
      JSON.stringify(
        channels.map((channel) => ({
          channel_id: channel.id,
          name: channel.name,
          kind: channelKind(channel),
          is_member: channel.is_member ?? false,
          num_members: channel.num_members,
        })),
        null,
        2,
      ),
    );
    return;
  }

  log.out(formatChannelsTable(channels));
  log.out('');
  log.out(`${channels.length} 件（名前順） / トークン: ${config.tokenSource}`);
  log.out('例: npm run export:slack -- --channel=<channel_id> --from=2026-07-01');
  if (channels.some((channel) => !channel.is_member)) {
    log.out('');
    log.out('※「参加」列が空のチャンネルは、Bot トークンだと履歴を取得できないことがあります。');
    log.out('  その場合はチャンネルで /invite するか、ユーザートークン（xoxp-）を使ってください。');
  }
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
