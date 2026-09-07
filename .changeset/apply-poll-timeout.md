---
'aio-proxy': patch
'@aio-proxy/dashboard': patch
---

Settings Update now treats a 120-second apply poll as a retryable failure, so the button is enabled again instead of staying on Updating. A Retry click disables the control immediately while that apply request is pending.
