# Requirements

- User requirement: all UI operations for both administrators and normal users must be based on user groups.
- Administrator identity has no implicit privilege; an administrator must explicitly grant themselves through groups before using protected UI/actions.
- Scope: permission derivation and initialization behavior; preserve group capability model.

# Classification

- Tier: high-risk because this touches auth/permission behavior.
- Execution: lead as implementer, lead self-review.
