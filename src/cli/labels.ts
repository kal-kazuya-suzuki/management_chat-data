/**
 * npm run labels — Gmail のラベル一覧を表示する。
 * --query でラベルを使って絞り込むときの名前確認用。
 */
import { loadGmailConfig } from '../config.js';
import { AccessTokenProvider } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import type { GmailLabel } from '../gmail/types.js';
import * as log from '../util/log.js';
import { displayWidth, padRight } from '../util/table.js';

export function formatLabelsTable(labels: readonly GmailLabel[]): string {
  if (labels.length === 0) return '該当するラベルはありませんでした。';

  const rows = labels.map((label) => ({
    name: label.name,
    type: label.type === 'system' ? 'システム' : 'ユーザー',
    total: label.messagesTotal === undefined ? '' : String(label.messagesTotal),
  }));

  const nameWidth = Math.max(10, ...rows.map((row) => displayWidth(row.name)));
  const typeWidth = 8;

  const lines = [
    `${padRight('ラベル名', nameWidth)}  ${padRight('種別', typeWidth)}  件数`,
    `${'-'.repeat(nameWidth)}  ${'-'.repeat(typeWidth)}  ------`,
  ];
  for (const row of rows) {
    lines.push(`${padRight(row.name, nameWidth)}  ${padRight(row.type, typeWidth)}  ${row.total}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const userOnly = argv.includes('--user-only');

  const config = loadGmailConfig();
  const client = new GmailClient({
    tokenSource: new AccessTokenProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
      ...(config.tokenEndpoint ? { tokenEndpoint: config.tokenEndpoint } : {}),
    }),
    baseUrl: config.baseUrl,
    userId: config.userId,
    rateLimit: config.rateLimit,
    rateWindowSeconds: config.rateWindowSeconds,
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
  });

  const profile = await client.getProfile();
  let labels = await client.listLabels();
  if (userOnly) labels = labels.filter((label) => label.type !== 'system');
  labels = [...labels].sort((a, b) => a.name.localeCompare(b.name));

  if (asJson) {
    log.out(JSON.stringify(labels, null, 2));
    return;
  }

  log.out(`メールボックス: ${profile.emailAddress}`);
  log.out('');
  log.out(formatLabelsTable(labels));
  log.out('');
  log.out(`${labels.length} 件`);
  log.out('例: npm run export:gmail -- --from=2026-07-01 --query="label:取引先"');
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
