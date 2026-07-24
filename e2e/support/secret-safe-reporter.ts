import type { FullConfig, FullResult, Reporter, Suite, TestError } from '@playwright/test/reporter';

/**
 * Prevent Playwright from injecting its line/dot reporter when all structured
 * reporters write to files. Those terminal reporters render test errors and
 * locator contexts before the artifact sanitizer can redact them.
 *
 * This reporter intentionally never renders test names, locations, errors, or
 * worker stdout/stderr. Its output is limited to fixed labels plus framework-
 * owned counts/status values.
 */
export default class SecretSafeReporter implements Reporter {
  printsToStdio(): boolean {
    return true;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    process.stdout.write(`Playwright run started: tests=${suite.allTests().length}\n`);
  }

  onError(_error: TestError): void {
    process.stderr.write('Playwright runner error; redacted details are retained in run artifacts\n');
  }

  onEnd(result: FullResult): void {
    process.stdout.write(`Playwright run completed: status=${result.status}\n`);
  }
}
