# @aio-proxy/cli

## 0.12.1

### Patch Changes

- Updated dependencies [[`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6)]:
  - @aio-proxy/types@0.12.1
  - @aio-proxy/core@0.12.1
  - @aio-proxy/server@0.12.1
  - @aio-proxy/dashboard@0.12.1
  - @aio-proxy/i18n@0.12.1
  - @aio-proxy/opencode-provider@0.12.1
  - @aio-proxy/pi-provider@0.12.1
  - @aio-proxy/plugin-sdk@0.12.1
  - @aio-proxy/logger@0.12.1
  - @aio-proxy/shared@0.12.1

## 0.12.0

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks [@baranwang](https://github.com/baranwang)! - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
- Updated dependencies [[`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2), [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca)]:
  - @aio-proxy/plugin-sdk@0.12.0
  - @aio-proxy/core@0.12.0
  - @aio-proxy/server@0.12.0
  - @aio-proxy/types@0.12.0
  - @aio-proxy/dashboard@0.12.0
  - @aio-proxy/i18n@0.12.0
  - @aio-proxy/logger@0.12.0
  - @aio-proxy/shared@0.12.0
  - @aio-proxy/opencode-provider@0.12.0
  - @aio-proxy/pi-provider@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies [[`2bb3f13`](https://github.com/aio-proxy/aio-proxy/commit/2bb3f13f1be3707125777d080878850ef52bb865)]:
  - @aio-proxy/dashboard@0.11.2
  - @aio-proxy/core@0.11.2
  - @aio-proxy/i18n@0.11.2
  - @aio-proxy/logger@0.11.2
  - @aio-proxy/plugin-sdk@0.11.2
  - @aio-proxy/server@0.11.2
  - @aio-proxy/types@0.11.2
  - @aio-proxy/opencode-provider@0.11.2
  - @aio-proxy/pi-provider@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/core@0.11.1
  - @aio-proxy/server@0.11.1
  - @aio-proxy/dashboard@0.11.1
  - @aio-proxy/i18n@0.11.1
  - @aio-proxy/logger@0.11.1
  - @aio-proxy/plugin-sdk@0.11.1
  - @aio-proxy/types@0.11.1
  - @aio-proxy/opencode-provider@0.11.1
  - @aio-proxy/pi-provider@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [[`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13), [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b), [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608), [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612), [`e0c9ea0`](https://github.com/aio-proxy/aio-proxy/commit/e0c9ea0b6c8cea6329cf2eeefc2dc4ee2675d44c)]:
  - @aio-proxy/core@0.11.0
  - @aio-proxy/types@0.11.0
  - @aio-proxy/plugin-sdk@0.11.0
  - @aio-proxy/server@0.11.0
  - @aio-proxy/opencode-provider@0.11.0
  - @aio-proxy/pi-provider@0.11.0
  - @aio-proxy/dashboard@0.11.0
  - @aio-proxy/logger@0.11.0
  - @aio-proxy/i18n@0.11.0

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks [@baranwang](https://github.com/baranwang)! - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

### Patch Changes

- Updated dependencies [[`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402), [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1), [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1)]:
  - @aio-proxy/plugin-sdk@0.10.0
  - @aio-proxy/core@0.10.0
  - @aio-proxy/i18n@0.10.0
  - @aio-proxy/dashboard@0.10.0
  - @aio-proxy/server@0.10.0
  - @aio-proxy/logger@0.10.0
  - @aio-proxy/types@0.10.0
  - @aio-proxy/opencode-provider@0.10.0
  - @aio-proxy/pi-provider@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`2e19250`](https://github.com/aio-proxy/aio-proxy/commit/2e192507075833219fff1bec8379f4144b383c84), [`af389a5`](https://github.com/aio-proxy/aio-proxy/commit/af389a50b57f123c71965cd337185cb8185629e1), [`fcef8e5`](https://github.com/aio-proxy/aio-proxy/commit/fcef8e5af578aee26df0db1b2ebb30bd6e50d3a0), [`1a1c519`](https://github.com/aio-proxy/aio-proxy/commit/1a1c519422c9be44a770646539803c929b5b9e43)]:
  - @aio-proxy/server@0.9.1
  - @aio-proxy/dashboard@0.9.1
  - @aio-proxy/core@0.9.1
  - @aio-proxy/types@0.9.1
  - @aio-proxy/logger@0.9.1
  - @aio-proxy/opencode-provider@0.9.1
  - @aio-proxy/pi-provider@0.9.1
  - @aio-proxy/i18n@0.9.1
  - @aio-proxy/plugin-sdk@0.9.1

## 0.9.0

### Minor Changes

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks [@baranwang](https://github.com/baranwang)! - Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The plugin SDK descriptor contract, brand, and host accepted version are restored to v1; v2 descriptors are rejected. The xAI artifact smoke gate now follows plugin API v1.

### Patch Changes

- [#188](https://github.com/aio-proxy/aio-proxy/pull/188) [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc) Thanks [@baranwang](https://github.com/baranwang)! - core: pin the bundled Bun runtime to 1.4.0 and restore streamed request bodies through HTTP proxies. Bun 1.4.0 ships the `fetch` + `proxy` `ReadableStream` body fix, so `createProxyFetch` no longer buffers the request. Plugin runtime compatibility is now Bun `>=1.4.0`. Compiled macOS binaries are ad-hoc re-signed after `bun build --compile` so they launch on macOS 27. Release runs on macOS so that signature is applied when the CLI is actually published.
- Updated dependencies [[`f8947e7`](https://github.com/aio-proxy/aio-proxy/commit/f8947e78bc3ec3c7ccfa04e6c82606d7fa7989d9), [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8), [`6560946`](https://github.com/aio-proxy/aio-proxy/commit/65609463e6ede5798787c54614d716f2120e8148), [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`bf6e779`](https://github.com/aio-proxy/aio-proxy/commit/bf6e779aad3d64f0edb4cdb4662f1063f1c6b279), [`ed5f7b7`](https://github.com/aio-proxy/aio-proxy/commit/ed5f7b78654738c9ca75178e2a060d3be628782b), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`f25104e`](https://github.com/aio-proxy/aio-proxy/commit/f25104ea345daeb6f4ec07f5db8fe505e6ca5da6), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`b71e13c`](https://github.com/aio-proxy/aio-proxy/commit/b71e13c8c991d3482a5446fdbd980ffc37a73ae1), [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5), [`21883d3`](https://github.com/aio-proxy/aio-proxy/commit/21883d33ab3ceb0081e123aaa985f42b4622f33d), [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00), [`1dcaf2d`](https://github.com/aio-proxy/aio-proxy/commit/1dcaf2d27278874035494b320690b43dfc5334fa), [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e), [`30113ac`](https://github.com/aio-proxy/aio-proxy/commit/30113ac44315a690a30360121fe196f1104a69be), [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1), [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e), [`cd6c5a3`](https://github.com/aio-proxy/aio-proxy/commit/cd6c5a3dd352ea22198d99345a6da3272510caca), [`798e1e2`](https://github.com/aio-proxy/aio-proxy/commit/798e1e2c230dd925f6a2df1741b52ee75c955852), [`cff1a38`](https://github.com/aio-proxy/aio-proxy/commit/cff1a38dda0e9c6e3c0be008580f8144f62ea725), [`35dacf3`](https://github.com/aio-proxy/aio-proxy/commit/35dacf3cfbd006598e0f1f7a4082f1f2399971c6), [`3cb3b81`](https://github.com/aio-proxy/aio-proxy/commit/3cb3b8135f109c0eb6ee9fab138e83ee32136ae0), [`165d4c1`](https://github.com/aio-proxy/aio-proxy/commit/165d4c1ef27a9519ff6a76387c1740643c038db1), [`e3ff7aa`](https://github.com/aio-proxy/aio-proxy/commit/e3ff7aa430a1a0d4429aa93e34f7e77836063c83), [`d50d78d`](https://github.com/aio-proxy/aio-proxy/commit/d50d78d7dcdac086fb529dfbafca425ce2281e62), [`c73de2d`](https://github.com/aio-proxy/aio-proxy/commit/c73de2d1bd7c849a239d8e6a3fe139f7b6be4da6), [`02c0a8b`](https://github.com/aio-proxy/aio-proxy/commit/02c0a8bc9b53175e72e2cc432275a04f8fb934dc), [`a3cf9b5`](https://github.com/aio-proxy/aio-proxy/commit/a3cf9b55e0377cd8df102acf3fd9463ff5899207), [`6fb3a79`](https://github.com/aio-proxy/aio-proxy/commit/6fb3a799f2abd3ee6f4fd11b01a7040be226257f), [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca), [`ef90e90`](https://github.com/aio-proxy/aio-proxy/commit/ef90e90173a91816649d5c76053caf776b30e5dc), [`ecb6e0c`](https://github.com/aio-proxy/aio-proxy/commit/ecb6e0c74220388cc4dd51445e994b0cef0865a5), [`b1bcb8d`](https://github.com/aio-proxy/aio-proxy/commit/b1bcb8dc140edff15f9534a8058dd038a2ee5717), [`5be2d7c`](https://github.com/aio-proxy/aio-proxy/commit/5be2d7c0c1f2e9d844b33ce17b3fcefc78afd62e), [`4c33182`](https://github.com/aio-proxy/aio-proxy/commit/4c33182e52533af7b613df3e67c82a3cba09cdb0), [`ea6b1c9`](https://github.com/aio-proxy/aio-proxy/commit/ea6b1c98ca4c9a9ba35b39de91df4b1b25165135), [`0a93cfd`](https://github.com/aio-proxy/aio-proxy/commit/0a93cfd509c919280fcfea53528e1a706edd36d5), [`e86cff1`](https://github.com/aio-proxy/aio-proxy/commit/e86cff1401ae66805faee73f5fa990a5249d52fb), [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b), [`c22a6ec`](https://github.com/aio-proxy/aio-proxy/commit/c22a6ec1e96f9b6e1b014f8601609565bef6ca23), [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250), [`f75367e`](https://github.com/aio-proxy/aio-proxy/commit/f75367ebf14dfd6a47c86c19f0851f27065c6876), [`476b0a8`](https://github.com/aio-proxy/aio-proxy/commit/476b0a8133f3c2a46e710e682006bf8074170bb5), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309)]:
  - @aio-proxy/dashboard@0.9.0
  - @aio-proxy/i18n@0.9.0
  - @aio-proxy/types@0.9.0
  - @aio-proxy/plugin-sdk@0.9.0
  - @aio-proxy/core@0.9.0
  - @aio-proxy/server@0.9.0
  - @aio-proxy/opencode-provider@0.9.0
  - @aio-proxy/pi-provider@0.9.0
  - @aio-proxy/logger@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203), [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705), [`4f73aa6`](https://github.com/aio-proxy/aio-proxy/commit/4f73aa69236d458a8ad8c811287fad03d674ad43), [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9)]:
  - @aio-proxy/core@0.8.0
  - @aio-proxy/server@0.8.0
  - @aio-proxy/types@0.8.0
  - @aio-proxy/dashboard@0.8.0
  - @aio-proxy/i18n@0.8.0
  - @aio-proxy/logger@0.8.0
  - @aio-proxy/plugin-sdk@0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

### Patch Changes

- Updated dependencies [[`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5)]:
  - @aio-proxy/core@0.7.0
  - @aio-proxy/server@0.7.0
  - @aio-proxy/types@0.7.0
  - @aio-proxy/dashboard@0.7.0
  - @aio-proxy/i18n@0.7.0
  - @aio-proxy/plugin-sdk@0.7.0
  - @aio-proxy/logger@0.7.0

## 0.6.4

### Patch Changes

- Updated dependencies [[`08a579c`](https://github.com/aio-proxy/aio-proxy/commit/08a579cad9b5192820cd42f2cbb6ba18e0bc9e18)]:
  - @aio-proxy/core@0.6.4
  - @aio-proxy/server@0.6.4
  - @aio-proxy/dashboard@0.6.4
  - @aio-proxy/i18n@0.6.4
  - @aio-proxy/logger@0.6.4
  - @aio-proxy/plugin-sdk@0.6.4
  - @aio-proxy/types@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies [[`ba2aeae`](https://github.com/aio-proxy/aio-proxy/commit/ba2aeae4dfae3d932e2a22ac97d816b74d32a5ca)]:
  - @aio-proxy/core@0.6.3
  - @aio-proxy/server@0.6.3
  - @aio-proxy/dashboard@0.6.3
  - @aio-proxy/i18n@0.6.3
  - @aio-proxy/logger@0.6.3
  - @aio-proxy/plugin-sdk@0.6.3
  - @aio-proxy/types@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [[`04ed2df`](https://github.com/aio-proxy/aio-proxy/commit/04ed2dff458272169af2bf04c36cfc09372f6557), [`52cb5ce`](https://github.com/aio-proxy/aio-proxy/commit/52cb5cef04cd1532dac2a773ee61b4fefd72d54d)]:
  - @aio-proxy/server@0.6.2
  - @aio-proxy/core@0.6.2
  - @aio-proxy/dashboard@0.6.2
  - @aio-proxy/i18n@0.6.2
  - @aio-proxy/logger@0.6.2
  - @aio-proxy/plugin-sdk@0.6.2
  - @aio-proxy/types@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [[`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7), [`5ab65bf`](https://github.com/aio-proxy/aio-proxy/commit/5ab65bf7ef8dd5b74e2589df30b6da7342436cb6)]:
  - @aio-proxy/dashboard@0.6.1
  - @aio-proxy/i18n@0.6.1
  - @aio-proxy/core@0.6.1
  - @aio-proxy/server@0.6.1
  - @aio-proxy/logger@0.6.1
  - @aio-proxy/plugin-sdk@0.6.1
  - @aio-proxy/types@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`963e395`](https://github.com/aio-proxy/aio-proxy/commit/963e3951a64644441a36b0ae4c9b93d644444d18), [`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee), [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085), [`465fa49`](https://github.com/aio-proxy/aio-proxy/commit/465fa494bc0446e11b68b0922b29ba2c15880c37), [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd)]:
  - @aio-proxy/core@0.6.0
  - @aio-proxy/server@0.6.0
  - @aio-proxy/types@0.6.0
  - @aio-proxy/dashboard@0.6.0
  - @aio-proxy/i18n@0.6.0
  - @aio-proxy/logger@0.6.0
  - @aio-proxy/plugin-sdk@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95)]:
  - @aio-proxy/i18n@0.5.2
  - @aio-proxy/core@0.5.2
  - @aio-proxy/dashboard@0.5.2
  - @aio-proxy/server@0.5.2
  - @aio-proxy/logger@0.5.2
  - @aio-proxy/plugin-sdk@0.5.2
  - @aio-proxy/types@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [[`1a525e8`](https://github.com/aio-proxy/aio-proxy/commit/1a525e861a0ef77668c3321f75171bb9e2880e9f)]:
  - @aio-proxy/core@0.5.1
  - @aio-proxy/server@0.5.1
  - @aio-proxy/dashboard@0.5.1
  - @aio-proxy/i18n@0.5.1
  - @aio-proxy/logger@0.5.1
  - @aio-proxy/plugin-sdk@0.5.1
  - @aio-proxy/types@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [[`7856451`](https://github.com/aio-proxy/aio-proxy/commit/7856451f2434912a619e1c72aca44a1ccd1aaf43), [`c6ecfc0`](https://github.com/aio-proxy/aio-proxy/commit/c6ecfc0dc81e6cb0f0c5cd7b27b79f32cfb0955c), [`d95834a`](https://github.com/aio-proxy/aio-proxy/commit/d95834ad85ea0352f5c389497ea008c687a80d64)]:
  - @aio-proxy/server@0.5.0
  - @aio-proxy/core@0.5.0
  - @aio-proxy/dashboard@0.5.0
  - @aio-proxy/i18n@0.5.0
  - @aio-proxy/logger@0.5.0
  - @aio-proxy/plugin-sdk@0.5.0
  - @aio-proxy/types@0.5.0

## 0.4.0

### Patch Changes

- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) [`d460128`](https://github.com/aio-proxy/aio-proxy/commit/d4601280f29a5322a30b4baa516bc1906d0ea324) Thanks [@baranwang](https://github.com/baranwang)! - cli: fix the managed service becoming unreachable after `brew upgrade`. The service unit now records the stable PATH launcher instead of the version-pinned Cellar binary, `service restart` regenerates an already-installed unit with a freshly resolved executable (recovering units that still point at a deleted old binary), and `resolveExec` falls back to the PATH launcher when the running executable was deleted mid-upgrade. `aio-proxy upgrade` now always restarts a managed daemon after upgrading (the `--restart` flag is removed); a manually started daemon still gets a self-restart hint.
- Updated dependencies [[`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282)]:
  - @aio-proxy/i18n@0.4.0
  - @aio-proxy/core@0.4.0
  - @aio-proxy/dashboard@0.4.0
  - @aio-proxy/server@0.4.0
  - @aio-proxy/logger@0.4.0
  - @aio-proxy/plugin-sdk@0.4.0
  - @aio-proxy/types@0.4.0

## 0.3.0

### Minor Changes

- [#117](https://github.com/aio-proxy/aio-proxy/pull/117) [`55d3ccd`](https://github.com/aio-proxy/aio-proxy/commit/55d3ccd49cb6819b8a413050a7a668efc9df17c0) Thanks [@baranwang](https://github.com/baranwang)! - cli: publish a multi-arch (amd64/arm64) Docker image to GHCR on release, and add a Dockerfile and docker-compose example for running aio-proxy in a container

### Patch Changes

- Updated dependencies [[`38960fd`](https://github.com/aio-proxy/aio-proxy/commit/38960fd9fca94d3e38cb5277a5eb928a3962d96a), [`5a6deb7`](https://github.com/aio-proxy/aio-proxy/commit/5a6deb759ed7c748369db2dee814d2686dcd2e8d)]:
  - @aio-proxy/core@0.3.0
  - @aio-proxy/server@0.3.0
  - @aio-proxy/dashboard@0.3.0
  - @aio-proxy/i18n@0.3.0
  - @aio-proxy/logger@0.3.0
  - @aio-proxy/plugin-sdk@0.3.0
  - @aio-proxy/types@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/core@0.2.1
  - @aio-proxy/dashboard@0.2.1
  - @aio-proxy/i18n@0.2.1
  - @aio-proxy/logger@0.2.1
  - @aio-proxy/plugin-sdk@0.2.1
  - @aio-proxy/server@0.2.1
  - @aio-proxy/types@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/core@0.2.0
  - @aio-proxy/dashboard@0.2.0
  - @aio-proxy/i18n@0.2.0
  - @aio-proxy/logger@0.2.0
  - @aio-proxy/plugin-sdk@0.2.0
  - @aio-proxy/server@0.2.0
  - @aio-proxy/types@0.2.0
