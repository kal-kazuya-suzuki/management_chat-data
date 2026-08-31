/**
 * npm run export:gmail — Gmail のやり取りを期間を指定してエクスポートする。
 *
 *   npm run export:gmail -- --from=2026-07-01
 *
 * 既定では「自分が送信したメール」で期間を絞り、該当したスレッド全体
 * （相手の返信を含む）を取得する。
 */
import { ArgError, GMAIL_EXPORT_USAGE, parseGmailExportArgs, type GmailExportArgs } from '../args.js';
import { loadGmailConfig } from '../config.js';
import { AccessTokenProvider } from '../gmail/auth.js';
import { GmailClient } from '../gmail/client.js';
import { fetchThreadsInRange } from '../gmail/pager.js';
import { renderJson, sanitizeForFilename, writeOutput } from '../output/files.js';
import {
  filterMineGmail,
  renderGmailMarkdown,
  renderGmailMineMarkdown,
  type GmailMarkdownContext,
} from '../output/gmail-markdown.js';
import { toTimeline } from '../output/gmail-record.js';
import { endOfDayEpoch, formatIso, startOfDayEpoch } from '../util/date.js';
import * as log from '../util/log.js';

async function main(): Promise<void> {
  let args: GmailExportArgs;
  try {
    args = parseGmailExportArgs(process.argv.slice(2), {
      defaultTz: process.env.CHATWORK_TZ_OFFSET,
    });
  } catch (error) {
    if (error instanceof ArgError) {
      log.error(error.message);
      log.info('');
      log.info(GMAIL_EXPORT_USAGE);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (args.help) {
    log.out(GMAIL_EXPORT_USAGE);
    return;
  }

  log.setVerbose(args.verbose);
  const config = loadGmailConfig();
  const tzOffsetMinutes = args.tzOffsetMinutes;
  const tzLabel = formatTzLabel(tzOffsetMinutes);

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

  const fromEpoch = startOfDayEpoch(args.from, tzOffsetMinutes);
  const toEpoch = endOfDayEpoch(args.to, tzOffsetMinutes);

  // 自分のアドレスは is_mine の判定に必須なので、未設定なら API から取る
  const myAddress = config.myAddress ?? (await client.getProfile()).emailAddress.toLowerCase();

  log.info('Gmail エクスポート');
  log.info(`  期間     : ${args.from} 〜 ${args.to} (${tzLabel}、両端を含む)`);
  log.info(`  形式     : ${args.format}`);
  log.info(`  出力先   : ${args.outDir}`);
  log.info(`  アドレス : ${myAddress}`);
  log.info(`  起点     : ${args.allMail ? '送受信すべて (--all-mail)' : '自分が送信したメール'}`);
  log.info(`  本文     : 引用${args.keepQuotes ? 'を残す' : 'を除去'} / 署名${args.keepSignature ? 'を残す' : 'を除去'}`);
  if (args.mine) {
    log.info(`  抽出     : 自分の送信メールのみ / ${args.minLength}文字以上`);
  }
  log.info('');

  const result = await fetchThreadsInRange(client, {
    fromEpoch,
    toEpoch,
    onlySent: !args.allMail,
    ...(args.query ? { extraQuery: args.query } : {}),
    pageSize: args.pageSize,
    maxPages: args.maxPages,
    maxThreads: args.maxThreads,
    onProgress: (progress) => {
      if (progress.phase === 'list') {
        log.step(`列挙 ページ ${progress.page}: 累計 ${progress.found} 通`);
        return;
      }
      const done = progress.threadsDone ?? 0;
      if (done === progress.threadsTotal || done % 10 === 0) {
        log.step(`スレッド取得 ${done}/${progress.threadsTotal}`);
      }
    },
  });

  log.debug(`検索クエリ: ${result.query}`);
  for (const warning of result.warnings) log.warn(warning);
  for (const note of result.notes) log.step(`補足: ${note}`);

  const timeline = toTimeline(result.threads, {
    myAddress,
    tzOffsetMinutes,
    keepQuotes: args.keepQuotes,
    keepSignature: args.keepSignature,
  }).filter((message) => message.body_plain.trim() !== '' || message.files.length > 0);

  const mineOptions = { myAccountId: myAddress, minLength: args.minLength };
  const jsonMessages = args.mine ? filterMineGmail(timeline, mineOptions) : timeline;

  log.step(
    `スレッド ${result.threads.length} 件 / メール ${timeline.length} 通` +
      (args.mine ? ` / 出力対象（自分の送信）${jsonMessages.length} 通` : ''),
  );

  const markdownContext: GmailMarkdownContext = {
    mailbox: myAddress,
    from: args.from,
    to: args.to,
    tzLabel,
    generatedAt: formatIso(Math.floor(Date.now() / 1000), tzOffsetMinutes),
    query: result.query,
    warnings: result.warnings,
    notes: result.notes,
  };

  const baseName = [
    'gmail',
    sanitizeForFilename(myAddress.split('@')[0] ?? 'mailbox'),
    args.from,
    args.to,
    ...(args.mine ? ['mine'] : []),
  ].join('_');

  const writtenFiles: string[] = [];

  if (args.format === 'json' || args.format === 'both') {
    const filePath = await writeOutput(args.outDir, `${baseName}.json`, renderJson(jsonMessages));
    writtenFiles.push(filePath);
    log.step(`書き出し: ${filePath}`);
  }

  if (args.format === 'md' || args.format === 'both') {
    const markdown = args.mine
      ? renderGmailMineMarkdown(timeline, markdownContext, mineOptions)
      : renderGmailMarkdown(timeline, markdownContext);
    const filePath = await writeOutput(args.outDir, `${baseName}.md`, markdown);
    writtenFiles.push(filePath);
    log.step(`書き出し: ${filePath}`);
  }

  log.info('');
  log.info('----------------------------------------');
  log.info(`出力ファイル : ${writtenFiles.length} 件`);
  log.info(`メール       : ${jsonMessages.length} 通`);
  log.info(`API リクエスト: ${client.totalRequests} 回（レート制限に当たった回数: ${client.totalRateLimitHits}）`);
  if (result.warnings.length > 0) {
    log.info('');
    log.warn(`警告が ${result.warnings.length} 件あります:`);
    for (const warning of result.warnings) log.step(warning);
  }
  log.info('');
  log.info('出力には取引先とのやり取りが含まれます。共有先・保管場所に注意してください。');
}

function formatTzLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'UTC';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
