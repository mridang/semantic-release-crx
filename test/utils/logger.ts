/**
 * A semantic-release style logger that records everything written to it.
 * @returns The logger and the lines it has received.
 */
export function recordingLogger() {
  const lines: string[] = [];
  const write = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  return {
    logger: { log: write, warn: write, error: write, success: write },
    lines,
  };
}
