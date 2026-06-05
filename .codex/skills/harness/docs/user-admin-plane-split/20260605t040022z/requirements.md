# Requirements

- Split user plane and admin plane interfaces.
- Admin capabilities must not grant user-plane resource access.
- Admin groups still need explicit server/image/mount-source grants to use resources.
- Update backend and frontend; remove historical bypass paths.

Risk: high-risk auth/API cross-package change.
