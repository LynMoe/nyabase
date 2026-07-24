#!/usr/bin/env bash
set -euo pipefail

# The checked-in Playwright config owns the complete reporter/output policy.
# Playwright otherwise accepts inherited process variables that can append a
# terminal reporter or bypass reporter-controlled worker stderr, exposing
# secret-bearing DOM/error state before artifact normalization can run.
unset PW_TEST_REPORTER
unset PW_TEST_DEBUG_REPORTERS
unset PW_RUNNER_DEBUG
unset DEBUG
unset PLAYWRIGHT_JSON_OUTPUT_FILE
unset PLAYWRIGHT_JSON_OUTPUT_DIR
unset PLAYWRIGHT_JSON_OUTPUT_NAME
unset PLAYWRIGHT_JUNIT_OUTPUT_FILE
unset PLAYWRIGHT_JUNIT_OUTPUT_DIR
unset PLAYWRIGHT_JUNIT_OUTPUT_NAME
unset PLAYWRIGHT_JUNIT_STRIP_ANSI
unset PLAYWRIGHT_JUNIT_INCLUDE_PROJECT_IN_TEST_NAME
unset PLAYWRIGHT_JUNIT_INCLUDE_RETRIES
unset PLAYWRIGHT_JUNIT_SUITE_ID
unset PLAYWRIGHT_JUNIT_SUITE_NAME
export PLAYWRIGHT_NO_COPY_PROMPT=1

exec "$@"
