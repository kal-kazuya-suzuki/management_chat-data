import { describe, expect, it } from 'vitest';
import { ArgError, DEFAULT_MIN_LENGTH, parseExportArgs, parseRoomIds, tokenize } from '../src/args.js';

const CONTEXT = { today: '2026-08-29' };

describe('parseExportArgs', () => {
  it('基本的な指定を読み取る', () => {
    const args = parseExportArgs(
      ['--room=123456789', '--from=2026-08-01', '--to=2026-08-29'],
      CONTEXT,
    );
    expect(args.roomIds).toEqual(['123456789']);
    expect(args.from).toBe('2026-08-01');
    expect(args.to).toBe('2026-08-29');
    expect(args.format).toBe('both');
    expect(args.mine).toBe(false);
    expect(args.minLength).toBe(DEFAULT_MIN_LENGTH);
  });

  it('--room はカンマ区切りで複数指定できる', () => {
    const args = parseExportArgs(['--room=111,222,333'], CONTEXT);
    expect(args.roomIds).toEqual(['111', '222', '333']);
  });

  it('--room を繰り返し指定してもまとめる', () => {
    const args = parseExportArgs(['--room=111', '--room=222,111'], CONTEXT);
    expect(args.roomIds).toEqual(['111', '222']);
  });

  it('--room=... 形式でも --room ... 形式でも受け付ける', () => {
    expect(parseExportArgs(['--room', '123'], CONTEXT).roomIds).toEqual(['123']);
  });

  it('--room も --all も無ければエラー（全ルーム一括を暗黙に行わない）', () => {
    expect(() => parseExportArgs(['--from=2026-08-01'], CONTEXT)).toThrow(ArgError);
    expect(() => parseExportArgs([], CONTEXT)).toThrow(/--room が指定されていません/);
  });

  it('--all を明示すればルーム指定なしでも通る', () => {
    const args = parseExportArgs(['--all'], CONTEXT);
    expect(args.all).toBe(true);
    expect(args.roomIds).toEqual([]);
  });

  it('--all と --room の併用はエラー', () => {
    expect(() => parseExportArgs(['--all', '--room=111'], CONTEXT)).toThrow(/同時に指定できません/);
  });

  it('--to 省略時は今日、--from 省略時は今日を含む直近30日', () => {
    const args = parseExportArgs(['--room=111'], CONTEXT);
    expect(args.to).toBe('2026-08-29');
    expect(args.from).toBe('2026-07-31');
  });

  it('--to だけ指定した場合はその日を基準に30日遡る', () => {
    const args = parseExportArgs(['--room=111', '--to=2026-03-10'], CONTEXT);
    expect(args.from).toBe('2026-02-09');
  });

  it('--from だけ指定した場合の --to は今日', () => {
    const args = parseExportArgs(['--room=111', '--from=2026-01-01'], CONTEXT);
    expect(args.to).toBe('2026-08-29');
  });

  it('日付の形式が不正ならエラー', () => {
    expect(() => parseExportArgs(['--room=111', '--from=2026/08/01'], CONTEXT)).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('存在しない日付はエラー', () => {
    expect(() => parseExportArgs(['--room=111', '--from=2026-02-30'], CONTEXT)).toThrow(
      /存在しない日付/,
    );
  });

  it('--from が --to より後ならエラー', () => {
    expect(() =>
      parseExportArgs(['--room=111', '--from=2026-08-29', '--to=2026-08-01'], CONTEXT),
    ).toThrow(/--from が --to より後/);
  });

  it('--format の値を検証する', () => {
    expect(parseExportArgs(['--room=1', '--format=md'], CONTEXT).format).toBe('md');
    expect(parseExportArgs(['--room=1', '--format=json'], CONTEXT).format).toBe('json');
    expect(() => parseExportArgs(['--room=1', '--format=csv'], CONTEXT)).toThrow(/--format/);
  });

  it('--mine と --min-length', () => {
    const args = parseExportArgs(['--room=1', '--mine', '--min-length=40'], CONTEXT);
    expect(args.mine).toBe(true);
    expect(args.minLength).toBe(40);
  });

  it('--min-length=0 は「除外しない」として通す', () => {
    expect(parseExportArgs(['--room=1', '--min-length=0'], CONTEXT).minLength).toBe(0);
  });

  it('--min-length に数字以外はエラー', () => {
    expect(() => parseExportArgs(['--room=1', '--min-length=あ'], CONTEXT)).toThrow(/--min-length/);
  });

  it('--tz でタイムゾーンを変えられる', () => {
    expect(parseExportArgs(['--room=1', '--tz=+00:00'], CONTEXT).tzOffsetMinutes).toBe(0);
    expect(parseExportArgs(['--room=1', '--tz=-05:00'], CONTEXT).tzOffsetMinutes).toBe(-300);
    expect(parseExportArgs(['--room=1'], CONTEXT).tzOffsetMinutes).toBe(540);
  });

  it('環境変数由来の既定タイムゾーンを使う', () => {
    const args = parseExportArgs(['--room=1'], { ...CONTEXT, defaultTz: '+00:00' });
    expect(args.tzOffsetMinutes).toBe(0);
  });

  it('不明なオプションはエラー', () => {
    expect(() => parseExportArgs(['--room=1', '--unknown=1'], CONTEXT)).toThrow(/不明なオプション/);
  });

  it('オプション以外の引数はエラー（--room の付け忘れを検出する）', () => {
    expect(() => parseExportArgs(['123456789'], CONTEXT)).toThrow(/オプション以外の引数/);
  });

  it('--help はルーム未指定でも通る', () => {
    expect(parseExportArgs(['--help'], CONTEXT).help).toBe(true);
    expect(parseExportArgs(['-h'], CONTEXT).help).toBe(true);
  });

  it('--max-pages は1以上', () => {
    expect(parseExportArgs(['--room=1', '--max-pages=5'], CONTEXT).maxPages).toBe(5);
    expect(() => parseExportArgs(['--room=1', '--max-pages=0'], CONTEXT)).toThrow(/1 以上/);
  });
});

describe('parseRoomIds', () => {
  it('カンマと空白の両方を区切りとして扱う', () => {
    expect(parseRoomIds(['111, 222  333'])).toEqual(['111', '222', '333']);
  });

  it('数字以外はエラー', () => {
    expect(() => parseRoomIds(['abc'])).toThrow(/room_id は数字/);
  });

  it('空文字は無視する', () => {
    expect(parseRoomIds(['111,,222'])).toEqual(['111', '222']);
  });
});

describe('tokenize', () => {
  it('値が必要なオプションに値が無ければエラー', () => {
    expect(() => tokenize(['--from'])).toThrow(/値が必要/);
    expect(() => tokenize(['--from', '--to'])).toThrow(/値が必要/);
  });

  it('真偽値フラグは値なしで受け付ける', () => {
    const raw = tokenize(['--mine', '--verbose']);
    expect(raw.values.has('mine')).toBe(true);
    expect(raw.values.has('verbose')).toBe(true);
  });
});
