# Changelog

## [0.1.0](compare/v0.0.1...v0.1.0) (2026-07-31)

### Features

* **cli:** add config show/edit/validate/path (no set/get) 363941a
* **cli:** add reload command hitting /admin/reload b8058f0
* **cli:** add service subtree, doctor, completion b79a93e
* **cli:** add status command (shallow + --deep) 572f095
* **cli:** exit-code contract (0 ok / 1 unrecoverable / 2 transient) 6c4d46a
* **cli:** let plugin add install ai-sdk provider packages c3bc99b
* complete streaming compression observability a138755
* **config:** add retryAfterCapMs and share retryAfterMilliseconds a7ff8c7
* **dashboard:** add request transform codecs 8b10f12
* **dashboard:** edit request transforms as json 7ee6014
* **dashboard:** edit request transforms visually 2cb4672
* **dashboard:** edit transform conditions visually 271bbe5
* **pipeline:** add ProviderCooldownStore backed by lru-cache dfb318e
* **pipeline:** write/skip/synthesize provider cooldown on 429 381c404
* **plugin-sdk:** define runtime fetch traffic 7cf9a70
* **protocol:** add adapter.errors.rateLimited native 429 builder 0c4d3d6
* **server-state:** provide ProviderCooldownStore on the route source a3297e6
* **server:** add attempt response observation collector e432e7e
* **server:** add loopback POST /admin/reload and real /health version 2e7c900
* **server:** apply provider request transforms a4fe743
* **server:** classify plugin runtime fetch traffic 6f24814
* **server:** evaluate provider request transforms e11f608
* **server:** observe attempt stream semantics 64180bf
* **types:** define provider request transforms 82f85b9

### Bug Fixes

* address provider transform review findings d2425c6
* align streaming observation metrics 5784585
* clear stale transform JSON diagnostics ab20e18
* **cli:** exit unrecoverable on bad startup config 1fdf693
* **cli:** harden control-plane URLs, unit escaping, and config edit 520f507
* **cli:** harden service unit and status probe 1a7a89b
* **cli:** honor config bind for status/reload/doctor and bracket IPv6 URLs 65ae3e2, closes #97
* **cli:** honor config bind, load service.env in validate, await editor 4985f6a
* **cli:** load service env as data in the daemon, not via shell 7beb4c4
* **cli:** make managed service resolve native binary and provider env 3ecb877
* **cli:** signal daemon-down and transient reload via exit code 2d73ecb
* **dashboard:** preserve pending transform drafts 9157655
* **dashboard:** recover transform validity after rollback e3e02fe
* **dashboard:** refine condition value editing aaa44cc
* **dashboard:** restore rejected json drafts 00a9c0a
* **dashboard:** stabilize transform condition editing 0f804ae
* **dashboard:** validate request transform conditions e376db3
* **dashboard:** validate request transform drafts 648c8af
* **dashboard:** wait for transform json validation df5d8d0
* **github-copilot:** mark credential traffic as control ab5e85f
* **google-antigravity:** classify runtime fetch traffic e074890
* keep counting after recoverable SSE errors 995f209
* **kimi-code:** mark oauth traffic as control 2c78525
* **kimi-code:** preserve runtime fetch metadata typing e142118
* **openai-chatgpt:** mark token traffic as control 7111ceb
* **plugin-sdk:** pass through non-ok event-stream responses without terminal enforcement 9afcc55
* **plugin-sdk:** restore plugin api version one ace4f61
* **server:** declare @ai-sdk/provider for attempt cooldown test ff941a5
* **server:** define null runtime fetch default 82cef19
* **server:** guard scalar transform conditions ef63587
* **server:** preserve observed zero SSE frame maximum 8d96be6
* **server:** preserve transform absence semantics 1c818be
* **server:** preserve transformed request body identity 3d0aa1c
* **server:** preserve TTFT observation timestamps d26b62a
* **server:** reject browser-originated admin reloads 58219f4
* **server:** split attempt loop context e544a09
* **types:** require canonical header transform reads 0545679
* **xai-grok:** mark oauth traffic as control 489ef38

## 0.0.1 (2026-07-29)

### ⚠ BREAKING CHANGES

- **cli:** replace --config flag and AIO_PROXY_CONFIG env with AIO_PROXY_HOME (breaking)
- **cli:** unify placeholder names and i18n every provider subcommand and option

### Features

- add CodeGraph documentation and configuration 79002ed
- add model usage billing 3e4fe3a
- add UI components and utilities for dashboard 8bd6e58
- **alias:** split model aliases from model ids 98ab39d
- **antigravity:** add Google Antigravity OAuth provider e028076
- **auth-flows:** add drizzle auth store 9091165
- **auth:** add GitHub Copilot OAuth provider support ([#5](issues/5)) 715862b
- change default port to 9317 346fcf1
- **cli+server:** add provider reload and dashboard events 4a97451
- **cli:** add dashboard development adapter c096c03
- **cli:** add provider login chatgpt subcommand 5c17a78
- **cli:** commander 15 + paraglide i18n + --lang pre-scan + binary smoke e44c52b
- **cli:** host oauth authorization flows 5a2d530
- **cli:** manage oauth plugins 2006b20
- **cli:** replace --config flag and AIO_PROXY_CONFIG env with AIO_PROXY_HOME (breaking) daf0143
- **cli:** unify placeholder names and i18n every provider subcommand and option 5638491
- **cli:** write versioned $schema into bootstrapped config 8ba2949
- **core/anthropic:** Messages schema and round-trip transform d6793c2
- **core/egress:** LanguageModelV2 stream → OpenAI Chat SSE encoder c296468
- **core/gemini:** generateContent schema and round-trip transform b485af9
- **core/ingress:** OpenAI Chat Completions wire schema with golden fixtures 8dba11e
- **core/npm:** self-spawn runtime package install fdfa1ee
- **core/provider/ai-sdk:** streamText wrapper for V2/V3 LanguageModel 592fc2a
- **core/provider/api:** openai-compatible passthrough provider with stream-tee tracing 2b71f70
- **core/responses:** schema transform and egress 357a876
- **core/router:** alias resolver with collision detection and provider/alias override a508a17
- **core/transform:** OpenAI Chat ↔ ModelMessage with round-trip tests d81bb59
- **core:** add Anthropic protocol adapter 1bec737
- **core:** add api provider ai sdk bridge bc13ac2
- **core:** add bundled ai-sdk provider loader 5af1ea6
- **core:** add canonical image input primitives 1464a73
- **core:** add file cache storage 5575908
- **core:** add Gemini protocol adapter 96660e9
- **core:** add oauth plugin vault 83dbf99
- **core:** add OpenAI protocol adapters eb72857
- **core:** add paths.ts as single source of truth for ~/.aio-proxy layout ad6b69b
- **core:** add request overview ledger 1746453
- **core:** add trace persistence schema 95df154
- **core:** apply API provider headers 18a5040
- **core:** centralize protocol error mapping 5c9fd55
- **core:** coordinate oauth credential refresh 2aadaf6
- **core:** define protocol adapter construction 8b42f20
- **core:** expose models.dev model metadata 51ed598
- **core:** inject redacted api.logger into plugin setup a93051d
- **core:** load staged oauth plugins f9194d6
- **core:** materialize config environment templates 47d08f2
- **core:** persist local traces atomically d31abcd
- **core:** preserve Anthropic message images 1127d2a
- **core:** preserve Gemini fileData and tool images 981521b
- **core:** preserve OpenAI Chat images 92b1886
- **core:** preserve OpenAI Responses images 687e2d3
- **core:** propagate provider network options 3a16548
- **core:** query request logs 4efd74a
- **core:** support multiple config formats 0505fe4
- **core:** use typed models.dev catalog 97b1a02
- **core:** wire ai-sdk provider runtime 3ef8b9b
- **dashboard:** adapt date picker for mobile fb54689
- **dashboard:** add appearance and language switchers 70e84ea
- **dashboard:** add combobox primitives b389ef1
- **dashboard:** add date time range value model db475f8
- **dashboard:** add desktop date time range picker 92c6f65
- **dashboard:** add local provider options schema resolver afbb54f
- **dashboard:** add Monaco code editor 1420f83
- **dashboard:** add pagination page window 32983dd
- **dashboard:** add request log query state 73f2a96
- **dashboard:** add request log viewer 53cd0ec
- **dashboard:** add schema-aware json editor a269f13
- **dashboard:** compact request log filters e59d057
- **dashboard:** compact token counts with exact hover values f512eea
- **dashboard:** extract shared ProtocolLabel for providers and logs 1853e5e
- **dashboard:** implement layout and navigation components, add Tailwind CSS support 2647b83
- **dashboard:** improve request log table a6fe894
- **dashboard:** load provider option schemas 8cf2f55
- **dashboard:** manage oauth providers visually d303a40
- **dashboard:** move usage into overview 645cde9
- **dashboard:** polish provider management 84c0f9a
- **dashboard:** refresh shadcn base-rhea components fb8a68e
- **dashboard:** replace logs with traces 4d6d880
- **dashboard:** resolve provider options schema locally instead of over HTTP 9a68890
- **dashboard:** reuse table pagination component 66c1161
- **dashboard:** show oauth plugin diagnostics 5cd5733
- **dashboard:** skip Monaco validation when JSON editor has no schema d3afb11
- **dashboard:** support custom date picker triggers 28e19ba
- **dashboard:** use date time picker for logs 6b0829b
- **dashboard:** validate provider options with json schema 3583224
- **dashboard:** visualize trace span trees a0dbd39
- **i18n:** paraglide-js + en/zh-CN seed + resolve + format-error 64d7475
- **i18n:** retarget provider options schema load error copy to package-status failure d6d4979
- **kimi:** add OAuth plugin package shell 5d42813
- **kimi:** discover coding models 14476a8
- **kimi:** embed OAuth provider f66e70c
- **kimi:** expose coding quota windows d96cfc8
- **kimi:** implement device OAuth flow e261a61
- **kimi:** route coding protocols 854def9
- **logger:** add LogTape-backed @aio-proxy/logger package d8904bc
- **logger:** harden secret redaction for plugin logs 7dec4d2
- **npm:** expose config schema from aio-proxy package b50c4a1
- **oauth:** add ChatGPT JWT accountId extractor fef72aa
- **oauth:** add ChatGPT OAuth loopback callback server 5f2ea4f
- **oauth:** add ChatGPT OAuth schemas c94be38
- **oauth:** add ChatGPT OAuth token exchange and refresh 1ddcda2
- **oauth:** add GitHub Copilot provider login 83ac5d6
- **oauth:** add OpenAI ChatGPT OAuth provider 28690af
- **oauth:** add PKCE helpers for ChatGPT OAuth 5718b48
- **oauth:** export ChatGPT OAuth provider bdca550
- **oauth:** implement ChatGPT OAuth login with PKCE flow and token management df119ca
- **oauth:** store vendor model list in login payload 6d6412c
- **oauth:** transact plugin account login a13ebd8
- **plugin-github-copilot:** migrate oauth adapter a51b85d
- **plugin-openai-chatgpt:** migrate oauth adapter a4d576b
- **plugin-sdk:** add Logger API and accept plugin versions 1-2 c398e20
- **plugin-sdk:** allow identity stream responses 72e0510
- **plugin-sdk:** define oauth plugin contract af11f20
- **plugin-sdk:** define oauth quota capability d3698ff
- **plugin-sdk:** expose host runtime fetch e00a49b
- **plugin-sdk:** generate exact oauth icon keys e51ce57
- **plugin-sdk:** support localized plugin copy 6ded416
- **plugins:** declare built-in oauth icons 853468e
- **plugins:** observe oauth runtime requests 7256ece
- **plugins:** sanitize oauth capability icons 2ff17bb
- **plugins:** validate oauth quota snapshots 4f3c8d9
- protect dashboard with config password 3168450
- **provider-schemas:** cache npm declaration sources fda29b1
- **provider-schemas:** generate expanded catalog from npm 632f558
- **provider-schemas:** generate provider option schemas 9b71299
- **provider-schemas:** parse provider declarations aceaf2e
- **provider:** add provider enabled flag ([#3](issues/3)) 6aa3aab
- **provider:** encode compatible tool images cdf54f2
- providers dashboard CRUD (list/new/edit/delete) ([#12](issues/12)) 2650c3a
- refactor renderCompiledEntry to use array for lines and improve readability 07f9ea7
- **responses:** support opencode ingress and request observability 4e34643
- **server/anthropic:** Messages SSE route and native passthrough d81bed6
- **server/gemini:** generateContent routes and native passthrough ebdf5de
- **server/responses:** route sync Responses ingress 4d756d5
- **server:** /v1/chat/completions with passthrough+transform dispatch 9a7b4df
- **server:** add ChatGPT OAuth runtime provider with fetch wrapper 6ba76d6
- **server:** add codex case B assembly 1a82350
- **server:** add codex client models orchestration baca486
- **server:** add codex models file cache ee67107
- **server:** add endpoint to retrieve OpenAI model list a7809f5
- **server:** add Hono HTTP access logging with unified requestId 9bf367d
- **server:** add isolated oauth quota reads c22e284
- **server:** add oauth alias derivation helper 4175bf3
- **server:** add safe wire debug snapshots b09e72d
- **server:** add shared model resolution layer 086125b
- **server:** add streaming debug body tap ca44e57
- **server:** bridge typed log sinks to LogTape logger b060886
- **server:** correlate request-scoped logs 62977ce
- **server:** correlate token count requests 666425e
- **server:** define debug body log events fe05fe6
- **server:** derive copilot routes from cached vendor models 9e6458e
- **server:** enrich models.dev model metadata 5222d81
- **server:** expose dashboard request logs ee6dc65
- **server:** expose provider option schemas 23fcd8d
- **server:** expose trace dashboard APIs 9a16392
- **server:** expose usage overview metrics 740c54a
- **server:** Hono boot on :22078 with health, dashboard config GET, CSRF middleware 8c6b7c2
- **server:** log complete upstream payload streams f73fe56
- **server:** materialize oauth plugin snapshots b769880
- **server:** migrate pipeline to trace store; record stream + ttft b5dc921
- **server:** non-streaming chat path + ingress error envelope translator 5eacc45
- **server:** observe api provider fetches af55d9b
- **server:** observe routed request outcomes 9694ef6
- **server:** persist logical session state 8222d78
- **server:** preflight candidate image compatibility e3493b2
- **server:** preserve oauth model metadata c4d94ae
- **server:** record request traces with opentelemetry 765d86a
- **server:** record terminal model requests 3a0b24a
- **server:** resolve provider proxy fetch 3f112e0
- **server:** return model list protocol superset f2b1d18
- **server:** serialize oauth quota resets f05e354
- **server:** serve codex catalog on client_version probe 5cc1c26
- **server:** tap complete inbound model requests 818b363
- **server:** trace protocol pipeline attempts 5962f6f
- share dashboard brand on login 8e27b08
- **traces:** complete metrics and ttft c185e8b
- **types:** add provider network config 7d2f754
- **types:** add server.logging config schema 73b1f93
- **types:** add shared codex upstream model schema d57e8fb
- **types:** allow openai-chatgpt oauth provider vendor fff6053
- **types:** describe config json schema 0380596
- **types:** publish config json schema 8a46617
- **types:** scope models config to api and ai-sdk providers b60ec98
- **types:** zod schemas for config, trace events, our own message/stream alias types 4abfd0e
- use object-shaped provider config ([#2](issues/2)) 795684a
- **xai-grok:** add built-in oauth provider b14eb6c
- **xai-grok:** add catalog and cli runtime f9c6acd
- **xai-grok:** add credits quota reader e25dbd8
- **xai-grok:** add oauth credential lifecycle 9dd2cd4
- **xai-grok:** use cli billing for quota 81c1d27
- 更新页面容器和侧边菜单样式，添加 Biome 配置文件 d15c392
- 添加项目配置文件和忽略规则 c9ce680

### Bug Fixes

- address final oauth plugin review cd94725
- **alias:** skip duplicate preserved self-alias route bf8ef02
- align protocol errors and architecture docs 43383e5
- **antigravity:** address oauth review feedback 8b16945
- **antigravity:** bound replay cache expiry work e004664
- **antigravity:** bound replay capture state 1ec2406
- **antigravity:** bound upstream response handling 5d25e5a
- **build:** track i18n message inputs 5e73af5
- **card:** remove redundant class properties for improved clarity 6ee4002
- **chatgpt:** load codex model catalog d9a4400
- **cli:** address oauth authorization review 5fd0d49
- **cli:** address oauth plugin lifecycle review e4d04e8
- **cli:** address task 7 review gaps 1ad3234
- **cli:** close plugin lifecycle safety gaps f6699d0
- **cli:** fail closed during plugin authorization 0956c09
- **cli:** harden plugin lifecycle concurrency cba137e
- **cli:** harden provider error provenance 5cad322
- **cli:** harden secret provenance and cleanup 1215d81
- **cli:** isolate plugin schema data 2f494cf
- **cli:** isolate plugin setup staging 73e3013
- **cli:** print startup urls cc20bd1
- **cli:** raise unit test timeout under turbo contention 98e2c8c
- **cli:** stop writing models into oauth provider config cded644
- close final oauth plugin review blockers 688872c
- complete cross-protocol image handling 6b77c41
- **config:** exclude kind from templates; handle CR line breaks 9950cee
- **config:** harden template resolver and authoring leaves da47ef6
- **copilot:** align split ownership e238de3
- **copilot:** localize host copy and cover outbound calls 2b491d5
- **core/egress:** accept AI SDK text stream parts in chat SSE writer a759267
- **core:** abort refresh on lease loss f1fdcc0
- **core:** aggregate usage with bigint 6804a29
- **core:** align protocol egress metadata 8b4a633
- **core:** allow recovery-fence contention test past 5s 88964e4
- **core:** apply sqlite busy timeout before wal d957da3
- **core:** avoid SQLite usage sum overflow c287466
- **core:** bound encoded gzip bodies 423a584
- **core:** capture default plugin logger routing c08dedd
- **core:** clarify migration hash recovery 41d6f74
- **core:** close oauth module split review gaps 960a2c0
- **core:** decode compressed request bodies 12c48ea
- **core:** decode gzip request bodies 206bb91
- **core:** default compatible provider name fea35ec
- **core:** disable OpenAI Responses storage 7983629
- **core:** distinguish alias renames from overrides e5dd0c2
- **core:** expose unaliased provider models e80557c
- **core:** forward anthropic tool definitions cd7715f
- **core:** guard full credential refresh lease 7267d2f
- **core:** harden file cache against traversal and malformed json 7f18cc4
- **core:** harden oauth plugin loading 2d2be57
- **core:** harden oauth vault compensation 05e8cc1
- **core:** harden request overview migration 994e09c
- **core:** ignore unsupported responses input items 082cfbe
- **core:** keep artifact smoke read-only 024fadf
- **core:** keep oversized Gemini images on 413 path a86bc93
- **core:** let aliases shadow configured models e8ce1b2
- **core:** make overview buckets DST-safe 7e60bad
- **core:** map request coding errors b3f350a
- **core:** narrow image FilePart data for declaration emit 631d555
- **core:** narrow request content encoding 07db46c
- **core:** normalize additional tools before messages d6e8eeb
- **core:** normalize compressed responses requests 9e2cdf5
- **core:** normalize passthrough encodings 3fc67c2
- **core:** persist usage cost as nano usd 59dc264
- **core:** preserve **proto** function tools 7dd6a15
- **core:** preserve Anthropic block order 7630138
- **core:** preserve Anthropic SSE text blocks a8e6911
- **core:** preserve Anthropic tool semantics bef3ae1
- **core:** preserve exact usage aggregation 27843a0
- **core:** preserve host authorization errors 3f47398
- **core:** preserve host authorization errors 4456485
- **core:** preserve indexed models.dev access 0f69d76
- **core:** preserve lock platform policies e15daf2
- **core:** preserve raw passthrough headers 56b9ab0
- **core:** preserve recovery acquisition errors c3069f2
- **core:** preserve recovery error semantics 79cab1f
- **core:** preserve responses semantic inputs 7999091
- **core:** preserve responses tool calls 4a0bead
- **core:** price-aware billable usage normalization 1f45e18
- **core:** propagate egress stream cancellation adc0e5e
- **core:** protect OpenAI AI SDK streams 7845abc
- **core:** protect OpenAI API passthrough streams c725779
- **core:** publish recovery fences atomically ea66b66
- **core:** recover abandoned config lock owners 6cf7253
- **core:** redact quoted plugin fields 6c802f5
- **core:** reject unsupported codings before body read 199d79b
- **core:** resolve built plugin directory imports a063ded
- **core:** restore credential fixture cleanup f00621f
- **core:** sanitize passthrough credentials c457b57
- **core:** satisfy ai-sdk provider gate blockers 21c149c
- **core:** scope refresh and stale lock recovery fb5e92f
- **core:** secure plugin error boundaries 91ef65c
- **core:** share inclusive billable peel helper b40ca86
- **core:** stabilize npm install lock recovery under contention 4ef056c
- **core:** use bracket notation for process.env access in paths.ts 4ddc914
- **core:** use TypeScript 7 AST API for migrations 52018fb
- **core:** validate large base64 without regex blowup 1caa640
- **core:** validate request overview ledger 0df30f0
- correct oauth cleanup and login guidance 821e536
- **dashboard:** address oauth review feedback 8dd541a
- **dashboard:** address request log review 04dd9eb
- **dashboard:** address trace review findings 976c335
- **dashboard:** adopt usage filter tabs d044df0
- **dashboard:** align date range picker with select UX 5ab20d9
- **dashboard:** associate usage tabs and chart e0b7c03
- **dashboard:** bind dev server to ipv4 loopback fcd1587
- **dashboard:** clarify provider schema load errors a66069f
- **dashboard:** compact toolbar layout, state sync, and reset de87cfd
- **dashboard:** complete request log controls d227b75
- **dashboard:** complete trace detail view 2fb4735
- **dashboard:** compose usage tabs in chart header 69acd27
- **dashboard:** correct date picker layout 50a2007
- **dashboard:** decode usage aggregates as bigint 8a4d2dd
- **dashboard:** display operational trace status 94bab93
- **dashboard:** finalize pagination controls 9c1e487
- **dashboard:** format rsbuild config for biome check 1a2c102
- **dashboard:** gate provider schema side effects 113f376
- **dashboard:** give json editor a visible default height 1a10c7d
- **dashboard:** handle terminal oauth sessions 7beaef0
- **dashboard:** harden plugin diagnostics 66a591e
- **dashboard:** harden provider options form state bfe4974
- **dashboard:** harden provider schema workflow 4514809
- **dashboard:** hide unavailable TTFT 46576ef
- **dashboard:** improve table accessibility 02bd712
- **dashboard:** lock oauth edit during sessions 81c2eac
- **dashboard:** move page size into pagination f8193df
- **dashboard:** place date range validation errors a9cd9b4
- **dashboard:** prefer fresh schema request errors 347e6bd
- **dashboard:** preserve date range validation feedback 55a9127
- **dashboard:** preserve inclusive DST end boundary 20bc28e
- **dashboard:** preserve provider network secrets 116212e
- **dashboard:** preserve usage cost precision 2494625
- **dashboard:** qualify json validation results 22119ed
- **dashboard:** refresh providers after oauth create 142ff66
- **dashboard:** remove pagination link targets d5ed0ad
- **dashboard:** set router basepath to serve under /dashboard d34ec79
- **dashboard:** stabilize logs date range defaults 94ea497
- **dashboard:** sync common filters with URL state and add coverage 69f23f3
- **dashboard:** unblock provider install recovery b885148
- **dashboard:** use date range picker for logs e275374
- **dashboard:** validate trace ids from search urls 76aaf6f
- **deps:** remove unused @rslib/core dependency from devDependencies 4f035bb
- drop unplanned oxfmt sortImports style group 9c616b2
- **gemini:** preserve route tools and safety settings 6977282
- **gemini:** satisfy generateContent gate findings ecee96a
- **gemini:** validate passthrough inline data cap 3e8da19
- **github-copilot:** observe runtime token refresh 62a48be
- harden artifact verification boundary bbb2767
- harden dashboard authentication reloads 5ccfaa3
- harden plugin migration and runtime gates 5005dd9
- harden trace session affinity cb446af
- **i18n:** ignore generated inlang metadata b9773c0
- **i18n:** restore composite build outputs 386287e
- **kimi:** handle OAuth polling errors e49e68b
- **kimi:** harden OAuth lifecycle 51f0eae
- **kimi:** identify AIO-Proxy requests 5c3e3c0
- **kimi:** sanitize raw request errors 53a0aa3
- **logger:** close redaction collision gaps ca60f84
- **logger:** restore default console routing 13f5495
- **logger:** route console to stderr and redact Map/Set safely 4291a58
- **logger:** sanitize error keys and reject function values bb73781
- **models:** address catalog review feedback df58ef8
- **npm:** handle shim signals bcee4ad
- **oauth:** address account login review 263440f
- **oauth:** close final plugin review findings 59f6316
- **oauth:** fence rotating credential refresh cfbdd24
- **oauth:** localize provider id collisions 60a5015
- **oauth:** use non-deprecated loose ChatGPT token schema 04841c8
- **openai-chatgpt:** drop inbound host header e9d205d
- **openai-chatgpt:** normalize Codex responses requests 9c42cf0
- **openai-chatgpt:** request uncompressed streams a02302e
- **openai-chatgpt:** resolve runtime entry explicitly 18dd3ca
- **openai-chatgpt:** share terminal-safe transport d681141
- **plugin-host:** preserve localized runtime boundaries 25ea64c
- **plugin-openai-chatgpt:** address review b2bcc33
- **plugin-sdk:** control compressed body decoding ff37a3f
- **plugin-sdk:** correct adapter variance and descriptor guard 9a9362b
- **plugin-sdk:** harden descriptor validation and tests da223b1
- **plugin-sdk:** harden OpenAI stream cleanup 56ab274
- **plugin-sdk:** materialize localized copy once 8f0be04
- **plugin-sdk:** narrow runtime descriptor identification 990beba
- **plugin-sdk:** pin authored PluginDescriptor to API v2 9bac865
- **plugin-sdk:** publish openai-stream rewrite options in dts bbc9f3d
- **plugin-sdk:** scope unit test discovery d336e41
- **plugin-sdk:** stop OpenAI streams at protocol terminal 71f26db
- **plugins:** address oauth icon and quota review b69f993
- **plugins:** import moved runtime barrels via explicit index c34f71c
- **plugins:** isolate corrupt plugin state d2349ec
- **plugins:** isolate oauth refresh policies da37081
- **plugins:** redact quota refresh option secrets 21e16c0
- **plugins:** reject raw icon data controls d442c65
- **plugins:** validate oauth icon data URLs f952ce4
- propagate dashboard auth unavailability 2792f47
- **provider-schemas:** bound archive entries f8314bd
- **provider-schemas:** canonicalize generator roots ed3fad2
- **provider-schemas:** collect declaration references from AST 9bc9714
- **provider-schemas:** expose Bun archive to Rspack VM 16f6589
- **provider-schemas:** fail closed on corrupt cache b307d5c
- **provider-schemas:** finalize cache safety 3155120
- **provider-schemas:** generate schemas only in dist 9dcfd99
- **provider-schemas:** harden declaration cache 4b49093
- **provider-schemas:** preserve parser and startup contracts 69a7f22
- **provider-schemas:** preserve root schema descriptions 6350fef
- **provider-schemas:** publish immutable cache observations 3c58900
- **provider-schemas:** rebuild generator module graph d3cac2b
- **provider-schemas:** run Rslib with Bun 8947f62
- **provider-schemas:** validate cached latest sources 76eee52
- **providers:** preserve schema validation after install errors 1b3bf6f
- **release:** address review feedback 97432b3
- **release:** annotated idempotent tag + explicit tag push 0c81f7e
- **release:** bump all workspace packages and harden resume 5cd974a
- **release:** correct package repository fields for provenance 33a6942
- **release:** embed built-in oauth plugins a21ccd5
- **release:** guard release branch, robust resume, prevent dep drift b9bd241
- **release:** resolve workspace deps via bun update, not hand-written versions d6fa7d7
- **repo:** resolve type-aware lint errors across packages 36ad3f3
- **repo:** wire workspace dev startup 989dc85
- **routing:** honor session ownership for token counts 661b978
- **scripts:** use Bun types for lock check 202631b
- **server:** address protocol routing review e6b9339
- **server:** alias-only metadata in model resolution c59d97b
- **server:** align model summaries with routing ce5ed05
- **server:** bill usage by source-aware accounting 4668073
- **server:** cache dashboard static assets 9ee3760
- **server:** catalog logtape and skip exact /dashboard access log ded870e
- **server:** classify passthrough body aborts 85626e9
- **server:** classify upstream aborts as cancelled in body tap 60f9b25
- **server:** close task 8 review gaps 0e9f37a
- **server:** configure logging before server initialization 7cba13c
- **server:** decouple failed response cleanup 1e6b3cf
- **server:** default responses to non-stream dc581f1
- **server:** enforce bounded request bodies 1e263e1
- **server:** enforce materialized provider capabilities 2e8ad02
- **server:** expose chatgpt oauth routes from static vendor models 643566b
- **server:** expose provider.models via /v1/models 08a55b4
- **server:** fence oauth account deletion 302e2d0
- **server:** gate body-tap cancellation on the inbound abort signal 2b40f4e, references #86
- **server:** give synthesized Codex models deterministic priorities c56bfc7
- **server:** handle live stream cancellation 26ea72d
- **server:** harden codex catalog synthesis and cache c01e6cd
- **server:** harden codex synthesis against bad effort, pdf modality, cache read errors fc6c7fb
- **server:** harden model metadata resolution e58fd58
- **server:** harden oauth account cleanup f49fb18
- **server:** harden oauth quota failure handling 752c8e1
- **server:** harden provider dashboard flows d2f04a3
- **server:** harden request usage capture 3f7f9f0
- **server:** harden wire debug snapshots 936b53a
- **server:** isolate headerless logical sessions d8212ab
- **server:** isolate oauth control traffic 803fca4
- **server:** list only alias-exposed models in /v1/models 343d3cf
- **server:** log provider attempt failures 540e7ba
- **server:** make debug snapshots non-interfering 87dfbef
- **server:** make isAbortError exception-safe on cause access a47fd6a, references #86
- **server:** parse Gemini usage arrays 13c0ea3
- **server:** preserve local provider options flow 834e64e
- **server:** preserve model stream backpressure 40e9d85
- **server:** reconcile codex models catalog with main rebase 5d6f4e9
- **server:** record terminal route failures 81845e3
- **server:** redact parsed quota account options 8f4d333
- **server:** reject unsupported request codings 1972de8
- **server:** reload atomically replaced config 3513c52
- **server:** report failed provider probes 349d820
- **server:** retain delete markers during recovery d41b4b9
- **server:** retain oauth delete marker on re-add race 4344240
- **server:** return 503 for missing ai-sdk chat streams 011f3e9
- **server:** serialize oauth deletion recovery 06b11e3
- **server:** settle pipeline failures before response commit 3a4500c
- **server:** stop config lock watcher reload loop ([#52](issues/52)) 0bf2057
- **server:** synthesize complete Codex ModelInfo entries 7811c3b
- **server:** tighten provider package metadata 686a772
- **server:** tighten task 8 module boundaries dd43a96
- **server:** tolerate malformed codex upstream rows per-item cf26412
- **server:** 处理 PR [#74](issues/74) review 反馈并补齐流式/TTFT 记录 f5aa79e, references #1 #2 #3 #4 #5 #6 #7 #8 #9
- **server:** 补齐 recorder 测试 mock 的 recover 方法并修正格式 866d209
- snapshot plugin option identity inputs 0d5de05
- store Codex models cache as object 8d01a98
- **traces:** correct model display, requested-model pricing, and stream idle timeout aca8fee
- **tracing:** address review feedback 8d20bb5
- **tracing:** classify cancellations and rejection codes 41a132f
- **tracing:** harden terminal lifecycle edges 804746c
- **tracing:** harden terminal persistence a25f5e9
- **tracing:** mark protocol-level stream failures 5b948f5
- **tracing:** preserve late stream cancellation de706f0
- **tracing:** preserve stream cancellation outcome 404fb0c
- **tracing:** report elapsed running durations 4f19009
- **types:** normalize preserved self aliases 31c8db3
- **types:** restrict server binding to loopback 1b4e585
- **usage:** address PR 48 review findings 90ca539
- **usage:** avoid pricing and chart key regressions ffe7aaa
- **usage:** bound passthrough usage parsing 988947f
- **usage:** isolate synthetic chart series a794a80
- **usage:** price the resolved target model and split usage capture 95fe581
- **usage:** resolve pricing through provider prefix, not OpenRouter only 3a90c0f
- **usage:** validate accounting inputs 1acba57
- **xai-grok:** advertise responses target protocol 5993937
- **xai-grok:** harden oauth retry handling c25151f
