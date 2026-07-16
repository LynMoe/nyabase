import { Injectable } from '@nestjs/common';

/** One explicit boundary for failures where continuing would renew unsafe authority. */
@Injectable()
export class FailStopService {
  terminate(error: unknown): never {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`[FATAL] Backend fail-stop: ${message}\n`);
    return process.exit(1);
  }
}
