---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Make the provider editor's section dots agree with its Save button, and fix the section hints. The
loudest colour now marks the state that blocks saving: a section that needs work is red, one that only
needs attention is amber, a finished one stays primary. Previously a savable "needs attention" section
showed the error colour next to an enabled Save button while the section that actually blocked the save
showed a colourless ring. Hint counts also read "1 model" rather than "1 models", and an OAuth provider
whose empty whitelist exposes its whole upstream catalog now says so instead of "0 models".
