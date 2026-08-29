import { describe, expect, it } from 'vitest';
import {
  endOfDayEpoch,
  formatDateOnly,
  formatDateTime,
  formatIso,
  parseTzOffset,
  shiftDays,
  startOfDayEpoch,
  todayInTz,
} from '../src/util/date.js';

const JST = 540;

describe('parseTzOffset', () => {
  it('よくある表記を解釈する', () => {
    expect(parseTzOffset('+09:00')).toBe(540);
    expect(parseTzOffset('+0900')).toBe(540);
    expect(parseTzOffset('+9')).toBe(540);
    expect(parseTzOffset('-05:30')).toBe(-330);
    expect(parseTzOffset('Z')).toBe(0);
  });

  it('不正な表記はエラー', () => {
    expect(() => parseTzOffset('JST')).toThrow(/オフセットの形式/);
    expect(() => parseTzOffset('+99:00')).toThrow(/範囲外/);
  });
});

describe('startOfDayEpoch / endOfDayEpoch', () => {
  it('JST の 00:00:00 は UTC の前日 15:00', () => {
    const epoch = startOfDayEpoch('2026-08-01', JST);
    expect(new Date(epoch * 1000).toISOString()).toBe('2026-07-31T15:00:00.000Z');
  });

  it('--to はその日の 23:59:59 まで含む', () => {
    const start = startOfDayEpoch('2026-08-29', JST);
    const end = endOfDayEpoch('2026-08-29', JST);
    expect(end - start).toBe(86_399);
    expect(formatIso(end, JST)).toBe('2026-08-29T23:59:59+09:00');
  });

  it('UTC 指定でも整合する', () => {
    expect(new Date(startOfDayEpoch('2026-08-01', 0) * 1000).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });
});

describe('formatIso', () => {
  it('オフセット付きの ISO8601 を返す', () => {
    // 2026-08-01T00:00:00Z = JST 09:00
    expect(formatIso(1_785_542_400, JST)).toBe('2026-08-01T09:00:00+09:00');
  });

  it('UTC のときは Z を使う', () => {
    expect(formatIso(1_785_542_400, 0)).toBe('2026-08-01T00:00:00Z');
  });

  it('負のオフセットにも対応する', () => {
    expect(formatIso(1_785_542_400, -300)).toBe('2026-07-31T19:00:00-05:00');
  });
});

describe('formatDateTime / formatDateOnly', () => {
  it('Markdown 用の表記', () => {
    expect(formatDateTime(1_785_542_400, JST)).toBe('2026-08-01 09:00');
    expect(formatDateOnly(1_785_542_400, JST)).toBe('2026-08-01');
    // 同じ瞬間でも UTC では前日
    expect(formatDateOnly(1_785_542_400, 0)).toBe('2026-08-01');
    expect(formatDateOnly(1_785_542_400 - 1, 0)).toBe('2026-07-31');
  });
});

describe('shiftDays', () => {
  it('日付をずらす', () => {
    expect(shiftDays('2026-08-29', -28)).toBe('2026-08-01');
    expect(shiftDays('2026-08-01', -1)).toBe('2026-07-31');
    expect(shiftDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('うるう年をまたぐ', () => {
    expect(shiftDays('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('todayInTz', () => {
  it('タイムゾーンによって日付が変わる', () => {
    // 2026-08-01T23:30:00Z → JST では翌日
    const nowMs = Date.UTC(2026, 7, 1, 23, 30, 0);
    expect(todayInTz(0, nowMs)).toBe('2026-08-01');
    expect(todayInTz(JST, nowMs)).toBe('2026-08-02');
  });
});
