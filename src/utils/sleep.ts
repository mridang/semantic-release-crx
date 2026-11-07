/**
 * Wait for a number of milliseconds.
 *
 * @param ms Duration to wait.
 * @returns A promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
