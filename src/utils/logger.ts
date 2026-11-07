interface Logger {
  readonly log: (...args: readonly unknown[]) => void;
  readonly warn?: (...args: readonly unknown[]) => void;
}

/**
 * Log a warning, falling back to the plain log when the logger has no `warn`.
 *
 * @param logger A semantic-release style logger.
 * @param message The message to log.
 */
export function warn(logger: Logger, message: string): void {
  if (logger.warn) {
    logger.warn(message);
  } else {
    logger.log(message);
  }
}
