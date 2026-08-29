/**
 * npm run export — Chatwork の会話を期間とルームを指定してエクスポートする。
 *
 *   npm run export -- --room=123456789 --from=2026-08-01 --to=2026-08-29
 */
import { ArgError, EXPORT_USAGE, parseExportArgs, type ExportArgs } from '../args.js';
import { loadConfig, type AppConfig } from '../config.js';
import { ChatworkClient } from '../chatwork/client.js';
import { MemberDirectory } from '../chatwork/members.js';
import { fetchMessagesInRange } from '../chatwork/pager.js';
import type { ChatworkRoom } from '../chatwork/types.js';
import { buildFileName, renderJson, writeOutput } from '../output/files.js';
import {
  filterMine,
  renderMarkdown,
  renderMineMarkdown,
  type MarkdownContext,
} from '../output/markdown.js';
import { resolveReplyTargetName, toExportedMessage } from '../output/record.js';
import { endOfDayEpoch, formatIso, startOfDayEpoch } from '../util/date.js';
import * as log from '../util/log.js';

interface RoomTarget {
  roomId: string;
  name: string | null;
  /** ルームの総メッセージ数。取得漏れの検知に使う */
  messageNum: number | null;
}

async function main(): Promise<void> {
  let args: ExportArgs;
  try {
    // dotenv は config.js の import 時に読み込まれているので、ここで既定値として使える。
    args = parseExportArgs(process.argv.slice(2), {
      defaultTz: process.env.CHATWORK_TZ_OFFSET,
    });
  } catch (error) {
    if (error instanceof ArgError) {
      log.error(error.message);
      log.info('');
      log.info(EXPORT_USAGE);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (args.help) {
    log.out(EXPORT_USAGE);
    return;
  }

  log.setVerbose(args.verbose);
  const config = loadConfig();
  const tzOffsetMinutes = args.tzOffsetMinutes;
  const tzLabel = formatTzLabel(tzOffsetMinutes);

  const client = new ChatworkClient({
    token: config.token,
    baseUrl: config.baseUrl,
    rateLimit: config.rateLimit,
    rateWindowSeconds: config.rateWindowSeconds,
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
  });

  const fromEpoch = startOfDayEpoch(args.from, tzOffsetMinutes);
  const toEpoch = endOfDayEpoch(args.to, tzOffsetMinutes);

  log.info('Chatwork エクスポート');
  log.info(`  期間     : ${args.from} 〜 ${args.to} (${tzLabel}、両端を含む)`);
  log.info(`  形式     : ${args.format}`);
  log.info(`  出力先   : ${args.outDir}`);

  const myAccountId = args.mine ? await resolveMyAccountId(client, config) : null;
  if (args.mine) {
    log.info(`  抽出     : 自分(account_id: ${myAccountId})の発言のみ / ${args.minLength}文字以上`);
  }

  const targets = await resolveTargets(client, args);
  log.info(`  対象     : ${targets.length} ルーム`);
  log.info('');

  const directory = new MemberDirectory(client);
  const writtenFiles: string[] = [];
  const allWarnings: string[] = [];
  let totalMessages = 0;

  for (const [index, target] of targets.entries()) {
    const label = `[${index + 1}/${targets.length}] room ${target.roomId}`;
    let roomName = target.name;
    let messageNum = target.messageNum;

    try {
      if (roomName === null) {
        const room = await client.getRoom(target.roomId);
        roomName = room?.name ?? `room_${target.roomId}`;
        messageNum = room?.message_num ?? null;
      }
      log.info(`${label} ${roomName}`);

      await directory.load(target.roomId);
      log.step(`メンバー ${directory.isLoaded(target.roomId) ? '取得済み' : '未取得'}`);

      const result = await fetchMessagesInRange(client, {
        roomId: target.roomId,
        fromEpoch,
        toEpoch,
        maxPages: args.maxPages,
        onProgress: (progress) => {
          const oldest =
            progress.oldestSendTime === null
              ? '-'
              : formatIso(progress.oldestSendTime, tzOffsetMinutes).slice(0, 16);
          log.step(
            `ページ ${progress.page}: +${progress.received} 件 / 累計 ${progress.total} 件（最古 ${oldest}）`,
          );
        },
      });

      // 取りこぼしがあるときは、ルームの総件数と突き合わせて規模を具体的に示す
      if (!result.coveredFrom && messageNum !== null && messageNum > result.fetchedCount) {
        result.warnings.push(
          `ルームの総メッセージ数 ${messageNum} 件に対し ${result.fetchedCount} 件しか取得できていません。` +
            '指定期間の全体はカバーできていません（README「取得の仕組みと制約」を参照）。',
        );
      }

      for (const warning of result.warnings) {
        log.warn(`room ${target.roomId}: ${warning}`);
        allWarnings.push(`room ${target.roomId}: ${warning}`);
      }

      const context = { roomId: target.roomId, roomName, directory, tzOffsetMinutes };
      for (const message of result.messages) {
        directory.remember(message.account?.account_id ?? '', message.account?.name);
      }
      const timeline = result.messages.map((message) => toExportedMessage(message, context));

      const byId = new Map(timeline.map((message) => [message.message_id, message]));
      const replyNames = new Map<string, string | null>();
      for (const [i, message] of timeline.entries()) {
        if (!message.reply_to) continue;
        replyNames.set(
          message.message_id,
          resolveReplyTargetName(result.messages[i]?.body ?? '', context, byId),
        );
      }

      const markdownContext: MarkdownContext = {
        roomId: target.roomId,
        roomName,
        from: args.from,
        to: args.to,
        tzLabel,
        generatedAt: formatIso(Math.floor(Date.now() / 1000), tzOffsetMinutes),
        replyNames,
        warnings: result.warnings,
      };

      const mineOptions = { myAccountId: myAccountId ?? '', minLength: args.minLength };
      const jsonMessages = args.mine ? filterMine(timeline, mineOptions) : timeline;
      totalMessages += jsonMessages.length;

      log.step(
        `期間内 ${timeline.length} 件` +
          (args.mine ? ` / 出力対象（自分の発言）${jsonMessages.length} 件` : ''),
      );

      if (args.format === 'json' || args.format === 'both') {
        const fileName = buildFileName({
          roomId: target.roomId,
          roomName,
          from: args.from,
          to: args.to,
          mine: args.mine,
          extension: 'json',
        });
        const filePath = await writeOutput(args.outDir, fileName, renderJson(jsonMessages));
        writtenFiles.push(filePath);
        log.step(`書き出し: ${filePath}`);
      }

      if (args.format === 'md' || args.format === 'both') {
        const markdown = args.mine
          ? renderMineMarkdown(timeline, markdownContext, mineOptions)
          : renderMarkdown(timeline, markdownContext);
        const fileName = buildFileName({
          roomId: target.roomId,
          roomName,
          from: args.from,
          to: args.to,
          mine: args.mine,
          extension: 'md',
        });
        const filePath = await writeOutput(args.outDir, fileName, markdown);
        writtenFiles.push(filePath);
        log.step(`書き出し: ${filePath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`${label} の処理に失敗しました: ${message}`);
      allWarnings.push(`room ${target.roomId}: 取得に失敗（${message}）`);
      process.exitCode = 1;
    }
    log.info('');
  }

  log.info('----------------------------------------');
  log.info(`出力ファイル : ${writtenFiles.length} 件`);
  log.info(`メッセージ   : ${totalMessages} 件`);
  log.info(`API リクエスト: ${client.totalRequests} 回`);
  if (allWarnings.length > 0) {
    log.info('');
    log.warn(`警告が ${allWarnings.length} 件あります:`);
    for (const warning of allWarnings) log.step(warning);
  }
  log.info('');
  log.info('出力には取引先とのやり取りが含まれます。共有先・保管場所に注意してください。');
}

/** --all のときは参加中の全ルーム、そうでなければ --room で指定されたルーム。 */
async function resolveTargets(client: ChatworkClient, args: ExportArgs): Promise<RoomTarget[]> {
  if (!args.all) {
    return args.roomIds.map((roomId) => ({ roomId, name: null, messageNum: null }));
  }
  log.warn('--all が指定されています。参加中の全ルームを取得します（時間と API 回数を大きく消費します）。');
  const rooms: ChatworkRoom[] = await client.getRooms();
  return rooms.map((room) => ({
    roomId: String(room.room_id),
    name: room.name,
    messageNum: room.message_num ?? null,
  }));
}

/** --mine の account_id は環境変数優先、無ければ GET /me。 */
async function resolveMyAccountId(client: ChatworkClient, config: AppConfig): Promise<string> {
  if (config.myAccountId) return config.myAccountId;
  const me = await client.getMe();
  log.debug(`GET /me から account_id=${me.account_id} を取得しました`);
  return String(me.account_id);
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
