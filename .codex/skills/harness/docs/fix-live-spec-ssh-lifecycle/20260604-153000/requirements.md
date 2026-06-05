# Requirements

- Mode: implementation / focused test-and-fix.
- Scope: fix clear live-test/product gaps in `/root/nyabase`.
- Primary low-risk item: beta/gamma/epsilon/delta live specs have invalid hard-coded SSH public keys causing 400; replace with valid OpenSSH public key or shared helper.
- Secondary: inspect/minimally fix container lifecycle operation/button gating only if clearly required and low-risk.
- Do not touch or create generated artifacts under `packages/common/src/**`.
- Verify with focused tests and common-source artifact guard.

Execution: lead as implementer.
