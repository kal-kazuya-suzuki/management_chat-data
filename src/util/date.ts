/**
 * 日付ユーティリティ。
 *
 * Chatwork の send_time / update_time は UNIX 秒(UTC)。
 * 一方 CLI の --from / --to は「日本時間の日付」で指定したいので、
 * 固定オフセット（既定 +09:00）で日境界を計算する。
 * 夏時間のあるタイムゾーンは想定しない（Chatwork の主用途が JST のため）。
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;

export const DAY_SECONDS = 86_400;

/** "+09:00" / "-0530" / "Z" / "+9" を UTC からの分数に変換する。 */
export function parseTzOffset(input: string): number {
  const raw = input.trim();
  if (raw === 'Z' || raw === 'z' || raw === 'UTC') return 0;

  const normalized = /^[+-]\d{1,2}$/.test(raw)
    ? `${raw[0]}${raw.slice(1).padStart(2, '0')}:00`
    : raw;

  const m = OFFSET_RE.exec(normalized);
  if (!m) {
    throw new Error(`タイムゾーンオフセットの形式が不正です: "${input}" (例: +09:00)`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 14 || minutes > 59) {
    throw new Error(`タイムゾーンオフセットが範囲外です: "${input}"`);
  }
  return sign * (hours * 60 + minutes);
}

/** YYYY-MM-DD を検証して {year, month, day} にする。存在しない日付（2月30日など）は弾く。 */
export function parseDateOnly(input: string): { year: number; month: number; day: number } {
  const m = DATE_ONLY_RE.exec(input.trim());
  if (!m) {
    throw new Error(`日付は YYYY-MM-DD 形式で指定してください: "${input}"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`存在しない日付です: "${input}"`);
  }
  return { year, month, day };
}

/** 指定タイムゾーンでの「その日の 00:00:00」の UNIX 秒。 */
export function startOfDayEpoch(dateOnly: string, offsetMinutes: number): number {
  const { year, month, day } = parseDateOnly(dateOnly);
  return Date.UTC(year, month - 1, day) / 1000 - offsetMinutes * 60;
}

/** 指定タイムゾーンでの「その日の 23:59:59」の UNIX 秒（--to を含む扱いにするため）。 */
export function endOfDayEpoch(dateOnly: string, offsetMinutes: number): number {
  return startOfDayEpoch(dateOnly, offsetMinutes) + DAY_SECONDS - 1;
}

/** 指定タイムゾーンでの日付を YYYY-MM-DD で返す。 */
export function formatDateOnly(epochSeconds: number, offsetMinutes: number): string {
  const shifted = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  return [
    String(shifted.getUTCFullYear()).padStart(4, '0'),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** "2026-08-01 10:12" 形式（Markdown 用）。 */
export function formatDateTime(epochSeconds: number, offsetMinutes: number): string {
  const shifted = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${formatDateOnly(epochSeconds, offsetMinutes)} ${hh}:${mm}`;
}

/** ISO8601（オフセット付き）。例: 2026-08-01T10:12:33+09:00 */
export function formatIso(epochSeconds: number, offsetMinutes: number): string {
  const shifted = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  if (offsetMinutes === 0) return `${date}T${time}Z`;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${date}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 指定タイムゾーンでの「今日」を YYYY-MM-DD で返す。 */
export function todayInTz(offsetMinutes: number, nowMs: number = Date.now()): string {
  return formatDateOnly(Math.floor(nowMs / 1000), offsetMinutes);
}

/** YYYY-MM-DD を days 日ずらす（負値で過去へ）。 */
export function shiftDays(dateOnly: string, days: number): string {
  const { year, month, day } = parseDateOnly(dateOnly);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_SECONDS * 1000);
  return formatDateOnly(Math.floor(shifted.getTime() / 1000), 0);
}
