import type { DesktopPlatform } from './desktop-download/detect-platform';

export interface HomeCopy {
  readonly hero: {
    readonly eyebrow: string;
    readonly titleLead: string;
    readonly titleAccent: string;
    readonly tagline: string;
    readonly primary: string;
    readonly secondary: string;
    readonly downloads: Record<DesktopPlatform, { readonly label: string; readonly note: string }>;
    readonly otherDownloads: string;
    readonly copy: string;
    readonly copied: string;
  };
  readonly stats: readonly { readonly value: string; readonly label: string }[];
  readonly protocols: {
    readonly kicker: string;
    readonly title: string;
    readonly body: string;
    readonly clientLabel: string;
    readonly upstreamLabel: string;
    readonly passthroughTitle: string;
    readonly passthroughBody: string;
    readonly convertTitle: string;
    readonly convertBody: string;
    readonly more: string;
  };
  readonly routing: {
    readonly kicker: string;
    readonly title: string;
    readonly body: string;
    readonly points: readonly { readonly title: string; readonly body: string }[];
    readonly replay: string;
    readonly request: string;
    readonly tier: string;
    readonly standby: string;
    readonly rateLimited: string;
    readonly served: string;
  };
  readonly subscriptions: {
    readonly kicker: string;
    readonly title: string;
    readonly body: string;
    readonly anyApi: string;
    readonly anyApiBody: string;
    readonly anySdk: string;
    readonly anySdkBody: string;
  };
  readonly agents: {
    readonly kicker: string;
    readonly title: string;
    readonly body: string;
    readonly points: readonly string[];
    readonly baseUrl: string;
  };
  readonly observability: {
    readonly kicker: string;
    readonly title: string;
    readonly body: string;
    readonly kpis: readonly { readonly label: string; readonly value: string; readonly delta: string }[];
    readonly columns: readonly string[];
    readonly traceTitle: string;
    readonly otel: string;
  };
  readonly start: {
    readonly kicker: string;
    readonly title: string;
    readonly steps: readonly { readonly title: string; readonly body: string; readonly code: string }[];
    readonly ctaTitle: string;
    readonly ctaBody: string;
  };
}

const en: HomeCopy = {
  hero: {
    eyebrow: 'Open source · Local-first model gateway',
    titleLead: 'Every model. Every client.',
    titleAccent: 'One endpoint.',
    tagline:
      'AIO Proxy sits between your tools and your model providers. Keep the SDKs and coding agents you already use, plug in API keys or the subscriptions you already pay for, and get routing, failover, and full request traces from one local binary.',
    primary: 'Get started',
    secondary: 'Star on GitHub',
    downloads: {
      macos: { label: 'Download for macOS', note: 'Apple Silicon · macOS 13+' },
      windows: { label: 'Download for Windows', note: 'x64 installer' },
      'linux-x86_64': { label: 'Download for Linux', note: 'AppImage · x86_64' },
      'linux-aarch64': { label: 'Download for Linux', note: 'AppImage · arm64' },
    },
    otherDownloads: 'Other platforms',
    copy: 'Copy',
    copied: 'Copied',
  },
  stats: [
    { value: '7', label: 'inbound API protocols' },
    { value: '10', label: 'built-in subscription plugins' },
    { value: '<1 ms', label: 'same-protocol passthrough overhead' },
    { value: '0', label: 'lines of client code to change' },
  ],
  protocols: {
    kicker: 'Protocols',
    title: 'Your clients keep speaking their language.',
    body: 'OpenAI, Anthropic, and Gemini clients all hit the same endpoint. When the upstream speaks the same protocol, bytes stream straight through. When it does not, AIO Proxy translates messages, tools, reasoning, and streaming for you.',
    clientLabel: 'Client speaks',
    upstreamLabel: 'Upstream serves',
    passthroughTitle: 'Raw passthrough',
    passthroughBody:
      'Request and stream piped as-is. Vendor headers, beta flags, and custom parameters survive untouched.',
    convertTitle: 'Cross-protocol conversion',
    convertBody:
      'Mapped through AI SDK model messages. Tool calls, thinking, multimodal input, and SSE chunks are translated both ways.',
    more: 'Also: Embeddings, Realtime (WebRTC / WebSocket), Images & Audio',
  },
  routing: {
    kicker: 'Routing & failover',
    title: 'Traffic that routes itself — and recovers on its own.',
    body: 'Ask for a model name. AIO Proxy finds every Provider that serves it, tries higher-priority tiers first, spreads traffic within a tier by weight, and fails over until one answers.',
    points: [
      { title: 'Model-first matching', body: 'Aliases map one name to many upstreams.' },
      { title: 'Priority tiers', body: 'Higher tiers first, lower tiers as standby.' },
      { title: 'Weighted spread', body: 'Share traffic across keys in the same tier.' },
      { title: 'Session affinity', body: 'Long conversations stay on the same Provider.' },
    ],
    replay: 'Replay',
    request: 'POST /v1/messages',
    tier: 'priority',
    standby: 'standby',
    rateLimited: '429 rate limited',
    served: '200 streaming',
  },
  subscriptions: {
    kicker: 'Providers',
    title: 'Bring the subscriptions you already pay for.',
    body: 'Log in once with OAuth and turn ChatGPT, Claude, Copilot, and more into standard API endpoints — shared by every tool on your machine.',
    anyApi: 'Any compatible API',
    anyApiBody: 'OpenAI, Anthropic, Gemini, or any gateway that speaks them.',
    anySdk: 'Any AI SDK provider',
    anySdkBody: 'Drop in an @ai-sdk/* package and configure it inline.',
  },
  agents: {
    kicker: 'Agents & clients',
    title: 'One command to wire up your coding agents.',
    body: '`aiop agent` detects installed agents, injects the provider config, and issues a dedicated local token — no copying base URLs between config files.',
    points: [
      'Codex, Grok Build, OpenCode, Pi, and OMP configured natively',
      'Session migration with a rollback journal',
      'Clean removal that leaves your preferences untouched',
    ],
    baseUrl: 'Everything else — Claude Code, Cursor, Cline, Cherry Studio, your own SDK code — just needs a base URL.',
  },
  observability: {
    kicker: 'Observability',
    title: 'Know where every request went, and what it cost.',
    body: 'The built-in Dashboard records every request and every Provider attempt: status, latency, tokens, and cost, with full traces when you need to dig in.',
    kpis: [
      { label: 'Requests', value: '12,480', delta: '+18%' },
      { label: 'Success rate', value: '99.7%', delta: '+0.4%' },
      { label: 'Tokens', value: '48.2M', delta: '+22%' },
      { label: 'Cost', value: '$31.06', delta: '−9%' },
    ],
    columns: ['Model', 'Provider', 'Status', 'Latency', 'Tokens', 'Cost'],
    traceTitle: 'Trace · claude-sonnet-4-6',
    otel: 'Export traces to any OpenTelemetry backend',
  },
  start: {
    kicker: 'Quick start',
    title: 'Running in under a minute.',
    steps: [
      { title: 'Install', body: 'One binary. Homebrew, Bun, or curl.', code: 'brew install aio-proxy/tap/aio-proxy' },
      { title: 'Run', body: 'Starts the API and opens the Dashboard.', code: 'aiop run --open' },
      {
        title: 'Point your client',
        body: 'Swap the base URL. Keep the model name.',
        code: 'export OPENAI_BASE_URL=http://127.0.0.1:9317/v1',
      },
    ],
    ctaTitle: 'Stop juggling keys, endpoints, and SDKs.',
    ctaBody: 'Free and open source. Runs on your machine.',
  },
};

const zh: HomeCopy = {
  hero: {
    eyebrow: '开源 · 本地优先的模型网关',
    titleLead: '所有模型，\u200b所有客户端，',
    titleAccent: '一个端点。',
    tagline:
      'AIO Proxy 位于你的工具与模型提供商之间。继续使用现有的 SDK 和编程 Agent，接入 API Key 或你已经订阅的服务，一个本地二进制即可获得智能路由、自动故障转移与完整请求链路。',
    primary: '开始使用',
    secondary: '在 GitHub 上 Star',
    downloads: {
      macos: { label: '下载 macOS 版', note: 'Apple Silicon · macOS 13+' },
      windows: { label: '下载 Windows 版', note: 'x64 安装程序' },
      'linux-x86_64': { label: '下载 Linux 版', note: 'AppImage · x86_64' },
      'linux-aarch64': { label: '下载 Linux 版', note: 'AppImage · arm64' },
    },
    otherDownloads: '其他平台',
    copy: '复制',
    copied: '已复制',
  },
  stats: [
    { value: '7', label: '种入站 API 协议' },
    { value: '10', label: '个内置订阅插件' },
    { value: '<1 ms', label: '同协议透传开销' },
    { value: '0', label: '行客户端代码需要修改' },
  ],
  protocols: {
    kicker: '协议',
    title: '客户端说什么语言，都不用改。',
    body: 'OpenAI、Anthropic、Gemini 客户端访问同一个端点。上游协议一致时字节流直接透传；协议不同时，AIO Proxy 自动转换消息、工具调用、推理内容与流式输出。',
    clientLabel: '客户端协议',
    upstreamLabel: '上游协议',
    passthroughTitle: '原样透传',
    passthroughBody: '请求与流式响应原样转发，厂商请求头、beta 标记与自定义参数完整保留。',
    convertTitle: '跨协议转换',
    convertBody: '经由 AI SDK 模型消息映射，工具调用、思考内容、多模态输入与 SSE 分片双向转换。',
    more: '另支持：Embeddings、Realtime（WebRTC / WebSocket）、图像与音频',
  },
  routing: {
    kicker: '路由与故障转移',
    title: '流量自己找路，失败自己恢复。',
    body: '只需请求一个模型名。AIO Proxy 找出所有提供该模型的 Provider，高优先级层先试，同层内按权重分摊流量，失败就自动切到下一个，直到成功。',
    points: [
      { title: '按模型匹配', body: '一个模型别名映射到多个上游。' },
      { title: '优先级分层', body: '高优先级先试，低优先级兜底。' },
      { title: '权重分流', body: '同一层级内按权重分摊流量。' },
      { title: '会话亲和', body: '长对话固定在同一个 Provider。' },
    ],
    replay: '重播',
    request: 'POST /v1/messages',
    tier: '优先级',
    standby: '待命',
    rateLimited: '429 触发限流',
    served: '200 流式返回',
  },
  subscriptions: {
    kicker: 'Provider',
    title: '把已有的订阅，变成标准 API。',
    body: '通过 OAuth 登录一次，就能把 ChatGPT、Claude、Copilot 等订阅变成标准 API 端点，供本机所有工具共享。',
    anyApi: '任意兼容 API',
    anyApiBody: 'OpenAI、Anthropic、Gemini，或任何兼容它们的网关。',
    anySdk: '任意 AI SDK Provider',
    anySdkBody: '引入 @ai-sdk/* 包，直接在配置中声明。',
  },
  agents: {
    kicker: 'Agent 与客户端',
    title: '一条命令接好你的编程 Agent。',
    body: '`aiop agent` 自动识别已安装的 Agent，注入 Provider 配置并签发专属本地令牌，无需在各种配置文件之间复制 Base URL。',
    points: ['原生支持 Codex、Grok Build、OpenCode、Pi 与 OMP', '会话迁移附带回滚日志', '移除时不动你的个人偏好'],
    baseUrl: '其他工具——Claude Code、Cursor、Cline、Cherry Studio 或你自己的 SDK 代码——只需改一个 Base URL。',
  },
  observability: {
    kicker: '可观测性',
    title: '每个请求去了哪、花了多少，一目了然。',
    body: '内置 Dashboard 记录每一次请求与每一次 Provider 尝试：状态、延迟、Token 与费用，需要时展开完整链路。',
    kpis: [
      { label: '请求数', value: '12,480', delta: '+18%' },
      { label: '成功率', value: '99.7%', delta: '+0.4%' },
      { label: 'Token', value: '48.2M', delta: '+22%' },
      { label: '费用', value: '$31.06', delta: '−9%' },
    ],
    columns: ['模型', 'Provider', '状态', '延迟', 'Token', '费用'],
    traceTitle: '链路 · claude-sonnet-4-6',
    otel: '将链路导出到任意 OpenTelemetry 后端',
  },
  start: {
    kicker: '快速开始',
    title: '一分钟内跑起来。',
    steps: [
      { title: '安装', body: '单个二进制，支持 Homebrew、Bun 或 curl。', code: 'brew install aio-proxy/tap/aio-proxy' },
      { title: '运行', body: '启动 API 服务并打开 Dashboard。', code: 'aiop run --open' },
      {
        title: '接入客户端',
        body: '替换 Base URL，模型名保持不变。',
        code: 'export OPENAI_BASE_URL=http://127.0.0.1:9317/v1',
      },
    ],
    ctaTitle: '别再手动切换 Key、端点和 SDK 了。',
    ctaBody: '免费开源，运行在你自己的机器上。',
  },
};

export const homeCopy = { en, zh } as const;
