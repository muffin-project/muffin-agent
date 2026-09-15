export const HEADLESS_TURN_TIMEOUT_SECONDS = 90;

export function headlessTestTimeoutMs(turns: number): number {
  return turns * 120_000;
}
