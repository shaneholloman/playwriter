---
'playwriter': patch
---

Add CDP log rotation to prevent unbounded `~/.playwriter/cdp.jsonl` growth.

The JSONL file now rotates when it exceeds 10,000 entries (configurable via `PLAYWRITER_CDP_LOG_MAX_ENTRIES`), keeping the last half. Rotation uses atomic temp-file + rename to avoid corruption.

Fixes #92
