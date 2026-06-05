# Requirements
- Inspect both fixed live servers for test leftover containers and directories.
- Remove all runtime containers not represented by active DB containers.
- Remove all data directories not represented by active DB data_directories.
- Preserve Docker internal directories and DB-backed active resources.
