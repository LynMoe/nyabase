# Definition Of Done

Use this as the lead's exit check.

## Always

- [ ] Latest user hard requirements are known.
- [ ] Each hard requirement is `done`, `failed`, `blocked`, or `conflict`.
- [ ] No actionable hard requirement remains unfinished.
- [ ] Evidence directly supports each completion claim.
- [ ] Existing suites, old plans, runbooks, and subagent reports did not shrink
      the user request.
- [ ] Skipped user-requested commands/tests/probes/personas are reported as
      failed or blocked, not residual risk.
- [ ] Final response compares work against user instructions.

## When Relevant

- [ ] Large work used subagents by responsibility/persona/risk, or the lead
      explains why direct execution was better.
- [ ] Multi-lane work has a short top-level rollup with file-backed evidence.
- [ ] Live/runtime claims hit the intended current runtime.
- [ ] Code/build/restart/deploy changes have post-change verification.
- [ ] Created runtime resources have cleanup proof or a cleanup blocker.
- [ ] UI visual claims have fresh render evidence inspected by the model.
- [ ] Security/auth/permission/data/release work has independent review or a
      clear reason why review was not possible.
- [ ] `packages/common/src/**` has no generated `.js`, `.js.map`, `.d.ts`, or
      `.d.ts.map` artifacts when relevant.
