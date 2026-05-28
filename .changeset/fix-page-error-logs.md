---
'playwriter': patch
---

Fix `getLatestLogs({ page })` so it includes page runtime errors and logs emitted from frame targets that belong to the page.

This makes hydration failures visible in the returned logs, including React errors surfaced through Playwright's `pageerror` event.
