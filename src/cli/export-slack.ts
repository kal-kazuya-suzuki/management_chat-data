/**
 * npm run export:slack — Slack の会話を期間とチャンネルを指定してエクスポートする。
 *
 *   npm run export:slack -- --channel=C0123ABCD --from=2026-07-01
 */
import {
  ArgError,
  SLACK_EXPORT_USAGE,
  parseSlackExportArgs,
  isChannelId,
  type SlackExportArgs,
} from '../args.js';
import { loadSlackConfig, type SlackConfig } from '../config.js';
import { SlackClient } from '../slack/client.js';
import { fetchChannelMessages } from '../slack/pager.js';
import { UserDirectory } from '../slack/users.js';
import type { SlackChannel } from '../slack/types.js';
import { buildFileName, renderJson, writeOutput } from '../output/files.js';
import {
  filterMine,
  renderMarkdown,
  renderMineMarkdown,
  type MarkdownContext,
} from '../output/markdown.js';
import { isSystemMessage, toSlackExportedMessage } from '../output/slack-record.js';
import { endOfDayEpoch, formatIso, startOfDayEpoch } from '../util/date.js';
import * as log from '../util/log.js';

interface ChannelTarget {
  id: string;
  name: string;
}

async function main(): Promise<void> {
  let args: SlackExportArgs;
  try {
    args = parseSlackExportArgs(process.argv.slice(2), {
      defaultTz: process.env.CHATWORK_TZ_OFFSET ?? process.env.SLACK_TZ_OFFSET,
    });
  } catch (error) {
    if (error instanceof ArgError) {
      log.error(error.message);
      log.info('');
      log.info(SLACK_EXPORT_USAGE);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (args.help) {
    log.out(SLACK_EXPORT_USAGE);
    return;
  }

  log.setVerbose(args.verbose);
  const config = loadSlackConfig();
  const tzOffsetMinutes = args.tzOffsetMinutes;
  const tzLabel = formatTzLabel(tzOffsetMinutes);

  const client = new SlackClient({
    token: config.token,
    baseUrl: config.baseUrl,
    rateLimit: config.rateLimit,
    rateWindowSeconds: config.rateWindowSeconds,
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
  });

  const fromEpoch = startOfDayEpoch(args.from, tzOffsetMinutes);
  const toEpoch = endOfDayEpoch(args.to, tzOffsetMinutes);

  log.info('Slack エクスポート');
  log.info(`  期間     : ${args.from} 〜 ${args.to} (${tzLabel}、両端を含む)`);
  log.info(`  形式     : ${args.format}`);
  log.info(`  出力先   : ${args.outDir}`);
  log.info(`  トークン : ${config.tokenSource}`);
  log.info(`  スレッド : ${args.includeThreads ? '返信も取得する' : '取得しない (--no-threads)'}`);

  const myUserId = args.mine ? await resolveMyUserId(client, config) : null;
  if (args.mine) {
    log.info(`  抽出     : 自分(user_id: ${myUserId})の発言のみ / ${args.minLength}文字以上`);
  }

  // ユーザー名は本文中のメンション解決にも使うので、最初に一括取得してキャッシュする
  const directory = new UserDirectory(client);
  await directory.load();
  log.info(`  ユーザー : ${directory.size} 人を取得`);

  const { targets, channelNames } = await resolveTargets(client, args);
  log.info(`  対象     : ${targets.length} チャンネル`);
  log.info('');

  const writtenFiles: string[] = [];
  const allWarnings: string[] = [];
  let totalMessages = 0;

  for (const [index, target] of targets.entries()) {
    const label = `[${index + 1}/${targets.length}] ${target.name} (${target.id})`;

    try {
      log.info(label);

      const result = await fetchChannelMessages(client, {
        channelId: target.id,
        fromEpoch,
        toEpoch,
        pageLimit: args.pageLimit,
        includeThreads: args.includeThreads,
        maxPages: args.maxPages,
        maxThreads: args.maxThreads,
        onProgress: (progress) => {
          if (progress.phase === 'threads') {
            // スレッドは件数が多くなるので10件ごとに出す
            if (progress.threadsDone === progress.threadsTotal || (progress.threadsDone ?? 0) % 10 === 0) {
              log.step(
                `スレッド ${progress.threadsDone}/${progress.threadsTotal} / 累計 ${progress.total} 件`,
              );
            }
            return;
          }
          const oldest =
            progress.oldestTs === null
              ? '-'
              : formatIso(Math.floor(progress.oldestTs), tzOffsetMinutes).slice(0, 16);
          log.step(
            `ページ ${progress.page}: +${progress.received} 件 / 累計 ${progress.total} 件（最古 ${oldest}）`,
          );
        },
      });

      for (const warning of result.warnings) {
        log.warn(`${target.name}: ${warning}`);
        allWarnings.push(`${target.name}: ${warning}`);
      }
      // 注意事項は毎回同じ内容なので、警告とは分けて控えめに出す
      for (const note of result.notes) log.step(`補足: ${note}`);

      const context = {
        channelId: target.id,
        channelName: target.name,
        directory,
        tzOffsetMinutes,
        channelNames,
      };

      let timeline = result.messages
        .filter((message) => args.includeSystem || !isSystemMessage(message))
        .filter((message) => args.includeBots || message.bot_id === undefined)
        .map((message) => toSlackExportedMessage(message, context));

      // 本文もファイルも無いメッセージ（削除済みなど）は落とす
      timeline = timeline.filter((message) => message.body_plain.trim() !== '' || message.files.length > 0);

      const markdownContext: MarkdownContext = {
        roomId: target.id,
        roomName: target.name,
        idLabel: 'channel_id',
        from: args.from,
        to: args.to,
        tzLabel,
        generatedAt: formatIso(Math.floor(Date.now() / 1000), tzOffsetMinutes),
        replyNames: buildReplyNames(timeline),
        warnings: result.warnings,
        notes: result.notes,
      };

      const mineOptions = { myAccountId: myUserId ?? '', minLength: args.minLength };
      const jsonMessages = args.mine ? filterMine(timeline, mineOptions) : timeline;
      totalMessages += jsonMessages.length;

      log.step(
        `期間内 ${timeline.length} 件（スレッド ${result.threadsFetched} 件を取得）` +
          (args.mine ? ` / 出力対象（自分の発言）${jsonMessages.length} 件` : ''),
      );

      const nameParts = {
        platform: 'slack',
        roomId: target.id,
        roomName: target.name,
        from: args.from,
        to: args.to,
        mine: args.mine,
      };

      if (args.format === 'json' || args.format === 'both') {
        const filePath = await writeOutput(
          args.outDir,
          buildFileName({ ...nameParts, extension: 'json' }),
          renderJson(jsonMessages),
        );
        writtenFiles.push(filePath);
        log.step(`書き出し: ${filePath}`);
      }

      if (args.format === 'md' || args.format === 'both') {
        const markdown = args.mine
          ? renderMineMarkdown(timeline, markdownContext, mineOptions)
          : renderMarkdown(timeline, markdownContext);
        const filePath = await writeOutput(
          args.outDir,
          buildFileName({ ...nameParts, extension: 'md' }),
          markdown,
        );
        writtenFiles.push(filePath);
        log.step(`書き出し: ${filePath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`${label} の処理に失敗しました: ${message}`);
      allWarnings.push(`${target.name}: 取得に失敗（${message}）`);
      process.exitCode = 1;
    }
    log.info('');
  }

  log.info('----------------------------------------');
  log.info(`出力ファイル : ${writtenFiles.length} 件`);
  log.info(`メッセージ   : ${totalMessages} 件`);
  log.info(`API リクエスト: ${client.totalRequests} 回（レート制限に当たった回数: ${client.totalRateLimitHits}）`);
  if (allWarnings.length > 0) {
    log.info('');
    log.warn(`警告が ${allWarnings.length} 件あります:`);
    for (const warning of allWarnings) log.step(warning);
  }
  log.info('');
  log.info('出力には取引先とのやり取りが含まれます。共有先・保管場所に注意してください。');
}

/** [rp] 相当（スレッド返信）の参照先の発言者名を作る。 */
function buildReplyNames(
  timeline: readonly { message_id: string; reply_to: string | null; account_name: string }[],
): Map<string, string | null> {
  const byId = new Map(timeline.map((message) => [message.message_id, message]));
  const replyNames = new Map<string, string | null>();
  for (const message of timeline) {
    if (!message.reply_to) continue;
    replyNames.set(message.message_id, byId.get(message.reply_to)?.account_name ?? null);
  }
  return replyNames;
}

/** --channel の指定（ID または名前）を実際のチャンネルに解決する。 */
async function resolveTargets(
  client: SlackClient,
  args: SlackExportArgs,
): Promise<{ targets: ChannelTarget[]; channelNames: Map<string, string> }> {
  const channelNames = new Map<string, string>();

  // 名前指定が1つでもあるか、--all のときは一覧が必要
  const needsList = args.all || args.channels.some((ref) => !isChannelId(ref));
  let all: SlackChannel[] = [];
  if (needsList) {
    all = await client.listChannels({ types: 'public_channel,private_channel' });
    for (const channel of all) {
      if (channel.name) channelNames.set(channel.id, channel.name);
    }
  }

  if (args.all) {
    log.warn('--all が指定されています。全チャンネルを取得します（時間と API 回数を大きく消費します）。');
    return {
      targets: all.map((channel) => ({ id: channel.id, name: channel.name ?? channel.id })),
      channelNames,
    };
  }

  const targets: ChannelTarget[] = [];
  for (const ref of args.channels) {
    if (isChannelId(ref)) {
      const info = await client.getChannelInfo(ref);
      const name = info?.name ?? ref;
      // Bot トークンで未参加のチャンネルは履歴が取れないので、取得前に知らせる
      if (info?.is_member === false) {
        log.warn(
          `#${name} には Bot が参加していません。履歴の取得に失敗する可能性があります` +
            '（チャンネルで /invite してください）。',
        );
      }
      channelNames.set(ref, name);
      targets.push({ id: ref, name });
      continue;
    }

    // 名前指定
    const matched = all.filter((channel) => channel.name === ref);
    if (matched.length === 0) {
      throw new ArgError(
        `チャンネル "#${ref}" が見つかりません。\n` +
          '  チャンネルIDで指定する場合は大文字で入力してください（例: C0123ABCD）。\n' +
          '  `npm run channels` で一覧を確認できます（プライベートチャンネルは参加していないと見えません）。',
      );
    }
    const channel = matched[0] as SlackChannel;
    targets.push({ id: channel.id, name: channel.name ?? channel.id });
  }

  return { targets, channelNames };
}

/** --mine の user_id は環境変数優先、無ければ auth.test。 */
async function resolveMyUserId(client: SlackClient, config: SlackConfig): Promise<string> {
  if (config.myUserId) return config.myUserId;
  const auth = await client.authTest();
  log.debug(`auth.test から user_id=${auth.user_id} を取得しました`);
  return auth.user_id;
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
