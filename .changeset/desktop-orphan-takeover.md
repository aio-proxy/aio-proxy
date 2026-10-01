---
'aio-proxy': patch
'@aio-proxy/cli': patch
---

The macOS app could not start the proxy after the CLI was removed with `brew uninstall`: the CLI's login service stayed behind, pointing at the deleted binary, and Start only relaunched it. The app now recognises such a leftover service and offers Take over, which moves it to the app on your click and keeps the existing config. A stopped proxy's panel now centres on the button that starts it, and no longer offers Open Dashboard while nothing is running.
