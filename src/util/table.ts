/** コンソール表示用の簡易テーブル整形。全角文字を2文字幅として扱う。 */

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
