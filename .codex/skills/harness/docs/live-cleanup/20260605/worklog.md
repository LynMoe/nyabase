# Worklog
- DB active containers before cleanup: CPU rere; GPU tess and test.
- DB active data_directories: none.
- Remote scan found 18 CPU orphan containers and 12 GPU orphan containers; only Docker internal top-level dirs were present under docker roots.
- Removed orphan containers with docker rm -f on both fixed live servers.
- Verification remote scan shows only DB active containers remain and no non-reserved top-level data dirs remain.
- packages/common/src generated artifact check: clean.
- After one agent report cycle, runtime_containers non-stale rows are only CPU rere and GPU tess/test; removed runtime rows are stale.
- data_dir_runtime_observations has no non-stale orphan directory rows.
