---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'@aio-proxy/ui': patch
'aio-proxy': patch
---

Agent authorization is completed on a single screen: the footer always offers stacked approve and deny buttons, disabled until the code entry is complete. Completing the code resolves it automatically — the request appears as a panel above the entry, a failed resolve shows an alert, and a code carried in a URL is simply pre-filled into the same flow. Approving or denying shows the final outcome, and expired, used, or already decided codes are reported with a toast.
