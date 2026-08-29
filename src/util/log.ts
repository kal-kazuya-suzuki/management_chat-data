/** 進捗表示用の最小限のロガー。ログはすべて stderr に出し、stdout は成果物専用にする。 */

let verboseEnabled = false;

export function setVerbose(value: boolean): void {
  verboseEnabled = value;
}

export function isVerbose(): boolean {
  return verboseEnabled;
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function step(message: string): void {
  process.stderr.write(`  ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`[警告] ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`[エラー] ${message}\n`);
}

export function debug(message: string): void {
  if (verboseEnabled) process.stderr.write(`[debug] ${message}\n`);
}

/** stdout への出力（rooms / me コマンドの結果など）。 */
export function out(message: string): void {
  process.stdout.write(`${message}\n`);
}
