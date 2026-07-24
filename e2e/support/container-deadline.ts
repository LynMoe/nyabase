export class ContainerDeadline {
  readonly expiresAt: number;

  constructor(
    timeoutMs: number,
    readonly label: string,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid deadline timeout for ${label}: ${timeoutMs}`);
    }
    this.expiresAt = Date.now() + timeoutMs;
  }

  remaining(stage: string, capMs?: number): number {
    const remainingMs = this.expiresAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`${this.label} exhausted before ${stage}`);
    }
    return Math.max(1, Math.min(remainingMs, capMs ?? remainingMs));
  }

  async delay(stage: string, delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, this.remaining(stage))));
  }
}
