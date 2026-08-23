---
'aio-proxy': patch
'@aio-proxy/server': patch
---

Raw provider `422` responses now fall through to the next live candidate. Other `4xx` statuses still return immediately.
