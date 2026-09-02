---
'aio-proxy': patch
---

Fix Dashboard OAuth authorization windows. Device-code providers now navigate the window opened on the
authorize click instead of leaving a blank tab that only loaded after switching back to the dashboard,
and the authorization panel no longer opens a second window on top of it — providers that authorize by
URL, such as Cursor, opened two authorization pages.
