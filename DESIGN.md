# 设计说明

本文记录生成器背后的设计决定和理由，以及实测得出的结论。目标版本：sing-box 1.14（用到了 `evaluate`、`respond`、`race`、`speculative`、`neighbor_domain`、`http_clients`、`preferred_by` 等 1.13/1.14 才有的功能）。

蓝本是作者在 SFM 中实际使用的配置（`test/fixtures/tiger-baseline.json`，已去除真实域名和密钥）。生成器先做到百分之百还原蓝本，再在此基础上重新设计 DNS 部分。

## 1. 分流模式

| 模式 | 直连 | 走代理 |
|---|---|---|
| Direct | 全部 | — |
| GFWList（默认） | 不在 gfwlist 里的 | gfwlist 里的域名，以及 Telegram、自定义 IP 段 |
| Non-CN | 国内域名列表（geosite-geolocation-cn）里的，或目标 IP 在国内的 | 其余 |
| Global | — | 全部（Tailscale 和内网除外） |

自定义直连域名和 IP 在除 Global 以外的模式下始终直连，优先级高于 gfwlist。IP 段放在 `custom-direct-ips`，只在填了 IP 时生成，只给路由用：DNS 按域名判断，和它无关。IP 主要用于 Non-CN 模式下只按地址连接的应用（游戏、P2P、远程桌面）和自己的服务器；GFWList 模式下没列出的 IP 本来就直连。

自定义代理域名和 IP 在除 Direct 以外的模式下始终走代理（也写入 `gfwlist-custom-domains`/`gfwlist-custom-ips`，所以 GFWList 模式原有的判断照样生效）；DNS 上按走代理处理（远程解析、只给 A）。同一个域名或 IP 同时出现在两个列表里时，直连优先。

规则：每条规则是一组域名/IP 加一个出口（任一节点或代理组），生成为一条 `route` 规则，指向该出口。除 Direct 外始终生效，位置在自定义直连之后、自定义代理之前，多条规则按列表顺序第一条匹配的生效。规则里的域名另放进 `custom-rule-domains`（只给 DNS 用），DNS 上和代理域名一样处理（远程解析、只给 A）；远程 DNS 仍经 `proxy` 访问，不经规则自己的出口。出口未选、已删除或是空代理组，或者没有有效条目时，这条规则不写入配置，并给出提醒。

DNS 分流：每条 DNS 规则是一组域名加一个 DNS 服务器（本地 DNS、代理 DNS，或用 JSON 自定义任意 sing-box DNS 服务器），匹配的域名交给它解析。典型用法：局域网域名（`.`、`lan`、`home.arpa`）交给路由器 192.168.1.1，其余照旧；也可以让公司域名用内网 DNS、某些域名指定 DoH。
- 只改“由谁解析”，不改流量走向：路由仍按模式和上面的列表决定。在所有模式下生效（包括 Direct）。
- 位置在 tailnet 分域 DNS 和 MagicDNS 之后，其他 DNS 规则之前，包括局域网域名默认交给本地 DNS 的两条（`preferred_by: local`、本地域名），所以能把局域网域名改交给路由器。多条规则按列表顺序第一条匹配的生效。
- 局域网域名（本地域名后缀和不带点的设备名）不套用下面的 IPv6 策略：和交给本地 DNS 时一样，所有记录照常返回。
- 列表里单独一个 `.` 表示不带点的设备名（如 `nas`），和 `local` 服务器 `neighbor_domain` 里的 `.` 同义，生成为 `domain_regex: ^[^.]+$`。所有列表都认这个写法。
- IPv6 策略不变：域名会走代理（代理域名、规则域名，或不能确定直连的，例如 Non-CN 模式下不在国内列表里的）时 AAAA、HTTPS、SVCB 返回空；确定直连时照常，本机没有公网 IPv6 时 AAAA 返回空。为此所有 DNS 规则的域名另放进 `custom-dns-domains`（只给 DNS 用）。
- 自定义服务器的标签是 `dns-rule-<序号>`；没写 `detour` 时直连访问（要经代理就写 `"detour": "proxy"`）。`detour` 不能写 `direct`（sing-box 拒绝指向空 direct 出站的 detour），指向不存在的出站也报错。JSON 有误或没有有效域名的规则不写入配置，并给出提醒。

所有域名列表（直连、代理、tailnet 的分域 DNS 和额外路由）的写法与 sing-box 一致，不另设语法：每行一项，不加前缀时按 `domain_suffix` 匹配（`example.com` 同时匹配子域名，`.example.com` 只匹配子域名），IP 和网段按 `ip_cidr`；也可以用字段名作前缀，写成 `domain:`、`domain_suffix:`、`domain_keyword:`、`domain_regex:`、`ip_cidr:`。正则按 Go RE2 校验（不支持环视和反向引用）；sing-box 拿小写后的域名去匹配正则，所以正则里出现大写字母会被判为错误（除非写了 `(?i)`）。`domain_regex:` 行里的逗号和 `#` 属于正则本身，注释要用空格隔开的 ` #`。

## 2. DNS 策略

**直连的流量只用本地 DNS**（网络下发的 DNS），不使用国内 DoH。
- 理由：国内不存在不经代理就能拿到干净结果的 DNS，换成阿里 DNS 并不能避免污染，反而多一次查询、多一个依赖（公司或校园网可能封外部 DNS）。
- 代价：本地 DNS 解析未缓存的国外域名偏慢（实测 500–650ms），这是在国内递归解析的固有成本。

**走代理的流量经代理问远程 DNS**（默认 Google DoT，可选 Cloudflare、Quad9，DoT 或 DoH；服务器标签统一为 `remote`）。
- 默认不发 ECS：走代理的流量，最优 CDN 节点应该靠近代理服务器，而不是用户；不带 ECS 时，Google 看到的就是代理服务器的 IP。

**Non-CN 模式下，不在国内域名列表里的域名，本地 DNS 和 Google 并行查询。**
- 本地 DNS 返回国内 IP 或内网 IP 时用本地结果（流量会直连），否则用 Google 的结果。
- 本地 DNS 超时设为 500ms：它卡住时直接用 Google 的结果，代价只是这个域名这次走了代理。
- 实测确认：回复会等本地 DNS 的结果判定后才发出，所以国内结果确实优先。

**DNS 缓存按服务器分开存**（缓存键包含服务器名、ECS 网段，本地 DNS 还包含当前网络），模式之间不会串用结果，换网络后本地 DNS 的缓存自动作废。

## 3. IPv6 策略

**走代理的流量只用 IPv4**：走代理的域名，AAAA、HTTPS（type 65）、SVCB（type 64）查询一律返回空，只给 A。
- 理由一：出口一致。IPv4 和 IPv6 不会从不同的服务器出去，避免风控严格的网站因为出口 IP 变化触发验证。
- 理由二：TUN 下应用不会从 IPv6 回退到 IPv4。sing-box 要先在本机完成 TCP 握手才能嗅探域名，应用的 Happy Eyeballs 因此认为 IPv6 已连上；如果代理服务器没有 IPv6，连接随后被重置，应用不会再尝试 IPv4（已实测：`curl` 同时给出 IPv6 和 IPv4 地址时选了 IPv6，0.5 秒后失败）。
- HTTPS/SVCB 也要清空，否则浏览器可以通过 `ipv6hint` 拿到 IPv6 地址。
- 代价：走代理的网站拿不到 ECH 和 HTTP/3 提示。流量本来就在代理隧道里，ECH 意义不大；HTTP/3 仍可通过 `Alt-Svc` 升级。

**应用自己发起的 IPv6 连接不拦截**（浏览器自带的安全 DNS、写死的 IP、缓存的地址），按嗅探到的域名正常分流；要走代理的，和 IPv4 一样走 `proxy`，从同一台服务器出去。当前服务器没有 IPv6 时这类连接会失败。所以建议浏览器的“安全 DNS”保持“自动”或关闭（Chrome/Edge 的自动模式不会对 TUN 的 DNS 地址升级成 DoH）。

**直连流量的 IPv6 照常使用**，但本机没有公网 IPv6 时（只有 IPv4 的网络）：
- 直连域名的 AAAA 返回空；
- 在握手前（pre-match）拒绝直连的国内 IPv6，让应用干净地回退到 IPv4。
  - 代理列表和规则里明确写出的 IP 段不在此列（两种模式都是）：写进去就说明要走代理，交给后面的规则处理。规则的 IP 段为此放进 `custom-rule-ips`（只给这条规则用）。同时写在直连列表里的不放行：路由上直连优先，没有 IPv6 时直连照样会失败。放行后这类 IPv6 连接经节点出去，要求节点所在服务器能访问 IPv6，否则会在节点那边失败，而不是立即被拒。

这两条依赖 `default_interface_address`。文档写的是只支持 Linux、Windows、macOS，但：
- 源码在拿不到网卡地址时判定为“不匹配”，而规则是反着用的，所以会按“没有 IPv6”处理，往安全的方向走（只用 IPv4，不会打不开网站）；
- 实测 iOS（SFI）上能正确识别公网 IPv6，直连可以用上 IPv6；
- Android 未实测。

**TUN 保留 IPv6 地址和路由。** 去掉的话，Linux/Windows 上 IPv6 会被 `strict_route` 禁用，Apple/Android 上 IPv6 很可能绕过 sing-box，导致各平台行为不一致、应用自己发起的 IPv6 流量不受分流管控。

**暂不提供“走代理也用 IPv6”的开关（2026-10-15 评估）**：可行方案已经分析过：开关默认关闭；开启后，走代理的 AAAA 经 `proxy` 用 IPv6 访问远程 DNS 来探测当前服务器有没有 IPv6，并用 `rewrite_ttl` 把 TTL 缩短到约 60 秒、不缓存。剩余风险是切换到没有 IPv6 的节点后，TTL 内用缓存地址发起的 IPv6 连接会被重置；`auto` 在节点之间自动切换时，这种情况可能频繁发生，而且用户察觉不到。收益很小（几乎没有只支持 IPv6 的网站），而应用自己发起的 IPv6 本来就不阻止，所以暂不引入。以后若有需求（例如某服务在 IPv4 出口上频繁要求验证），按此方案实现，并建议 `proxy` 默认使用只含 IPv6 节点的代理组。

**曾经的 `proxy-v6` 设计已移除**：它让 IPv6 单独选服务器，带来出口不一致，还需要手动标记哪些服务器有 IPv6。

## 4. Tailscale

- `preferred_by` 对 tailnet 设备和子网路由生效，并排除出口节点的 `/0` 路由（源码中 `peer.Route.Bits() > 0`），所以设置出口节点不会改变普通流量的走向。
- **分域 DNS 是关键**：例如把公司域名 `corp.example.com` 交给该 tailnet 的 DNS 解析，才能拿到内网地址（实测：同一个内部域名，经 tailnet DNS 解析为 `192.168.x.x`，公网 DNS 给的是公网地址）。
- **出口节点对访问子网不是必需的**：去掉 `exit_node` 后，子网里的域名解析和连接都照常（实测）。只有目标地址没有被任何子网路由覆盖时，才需要靠出口节点转发。
- Tailscale 重启后的第一次查询可能需要 2–3 秒建立连接，属于冷启动。

生成器中的 Tailscale 模块（每个 tailnet 一张卡片）：

| 选项 | 生成内容 |
|---|---|
| 端点 JSON（可写注释） | `endpoints` 中的一项，`type` 和 `tag` 由生成器填写 |
| MagicDNS | `<标签>-dns` 服务器 + `preferred_by` DNS 规则 |
| 使用 tailnet 的默认 DNS | DNS 服务器上的 `accept_default_resolvers` |
| 分域 DNS 域名 | 域名匹配 → `<标签>-dns`，放在所有 DNS 规则最前 |
| 额外路由 | 域名匹配/`ip_cidr` → 端点 |
| 作为代理出口 | 端点加入 `proxy` 选择器（不进 `auto`）；「出口节点」字段是 `exit_node` 的唯一来源（端点 JSON 里的会被忽略并提醒），导入时端点里的 `exit_node` 会提取到这个字段，但开关只看原配置里是否有选择器列出了该端点（只设了 `exit_node` 而没进任何组时保持关闭，出口节点只服务于额外路由）。字段只在开关打开（或已有值）时显示 |

`preferred_by` 路由规则和“拒绝直连国内 IPv6”规则里对 tailnet 的排除，都由生成器自动处理。

## 5. 可分享性的取舍

- 核心策略只保留一套，不开放逐条编辑。规则之间相互依赖（race 规则的顺序、`speculative` 的位置等），随手改一条可能悄悄出错；需要深度定制的用户直接修改生成的 JSON。
- 开放的策略选项：走代理时使用的 DNS 服务器；以及按域名指定 DNS 服务器的 DNS 分流（见第 1 节），它只改解析者，IPv6 策略照旧。除了三家预设，还可以选“自定义”，用一段 JSON 写任意 sing-box DNS 服务器（tcp/udp/tls/https/quic/h3），生成器填写 `tag: remote`，没写 `detour` 时补上 `proxy`。JSON 有误时报错，并暂时改用 Google，保证配置仍能加载。
- 导入：直接读现有的 sing-box 或 Clash 配置（不再有本工具自己的导入导出格式）。sing-box 配置只取节点（代理类出站和 WireGuard/OpenConnect/OpenVPN 端点）和 Tailscale（端点，及其 DNS 服务器的 MagicDNS、默认 DNS、分域 DNS，额外路由，是否在代理组里）。DNS 和分流规则由本工具的策略生成。
  - 节点引用的 `domain_resolver` 如果在新配置里不存在（例如 `cn-dns`），会去掉并说明。
  - 源配置有代理组时，不在任何组里的节点（例如 ShadowTLS 这种 detour 辅助节点）导入后也不加入代理组。
  - 总是新建一套配置，不并入正在编辑的配置；与本工具自带出站（`proxy`、`auto`、`direct`）重名的标签自动改名，detour 跟着改。
  - 测试：生成的配置再导入、再生成，节点、端点、DNS、路由规则完全一致；SFM 实际在用的配置也能正确导入。
  - 也能导入 Clash（mihomo）配置（YAML，或同样结构的 JSON，按内容自动识别）：`proxies` 逐个转换为等价的 sing-box 出站或端点，字段对照参考 Sub-Store 的 sing-box producer 和 xmdhs/clash2singbox。sing-box 表达不了的节点（ShadowsocksR、TUIC v4、xhttp 等传输、AmneziaWG、restls 等插件）跳过并列出；`shadow-tls` 插件拆成 ShadowTLS 辅助节点加 detour；`dialer-proxy` 指向节点时转为 `detour`，指向代理组时去掉并说明（这里的 detour 只接受节点）。
  - Clash 代理组：`select` → `selector`，`url-test` → `urltest`（`url`、`interval` 秒、`tolerance`）；`fallback`、`load-balance` 没有对应类型，改为 `urltest` 并说明；`relay` 展开成链式节点（后面每一跳复制一份并设 `detour`，最后一跳用组名，其他组仍可引用）。`include-all` 和 `filter`/`exclude-filter`/`exclude-type` 在导入时展开成具体成员（`(?i)` 转为忽略大小写）；`use` 引用的 proxy-providers 需要联网，不导入；`DIRECT`/`REJECT` 等内置策略不能当成员，去掉并说明；成员为空的组跳过，引用它的组随之去掉该成员。规则、DNS 不导入。
  - Clash 的节点名和组名大多含中文、emoji 和空格，所以标签和组名只要求非空、首尾无空白、不含控制字符（sing-box 本身接受任意字符串）。
- 支持全平台（Apple、Android、Linux、Windows）。
- 节点用 JSON 编辑（可写注释），从协议模板开始，覆盖 1.14 可作为代理节点的全部 18 种协议：15 种出站，加上 WireGuard、OpenConnect、OpenVPN 三种端点（WireGuard 出站在 1.14 中只剩空壳，必须用端点）。
  - 生成器只负责：填写 `tag`；`type` 为端点类型的放进 `endpoints`，其余放进 `outbounds`；没写 `domain_resolver` 时补上 `local`（节点服务器是直连访问的）；勾选“加入代理组”的节点进入 `proxy` 和 `auto`。
  - 校验：JSON 语法、`type` 是否支持、是否缺 `server`、密钥类字段是否为空、`server` 是否还是模板示例地址、`detour` 指向的节点是否存在。
  - 旧版用表单保存的 Hysteria2/VLESS 服务器，加载时自动转换为等价的 JSON 节点（测试验证转换后与蓝本逐字段一致）。
  - 代价：密码等敏感字段在 JSON 编辑框里是明文显示的，截图或共享屏幕时要注意。
- Tailscale 做成可选模块，可以有多个 tailnet（见第 4 节）。
- 作者个人习惯的规则做成开关，默认关闭：Steam（lancache 本地解析、Non-CN 下 steamcontent 直连）、禁止 iCloud 使用 QUIC。
- 平台选择目前只影响 TUN：Linux 上开启 `auto_redirect`。不能“全平台都写上”：源码（`protocol/tun/inbound.go`）在非 Linux 平台遇到 `auto_redirect` 会直接报错 `auto_redirect is only supported on Linux`，配置无法加载（macOS、iOS、Windows）。Android 能加载，但只做简单的 IPv4 TCP 转发，收益不明确且未实测，所以不开启。这也说明平台专属选项有的会被忽略、有的会报错，每个平台的生成结果都应该用 `sing-box check` 验证。
- 纯前端，运行时不发出任何网络请求；设置只保存在本地浏览器，可以保存多套命名配置（例如 Mac、iPhone 各一套）。
- 构建产物带 CSP（`vite.config.ts`）：只允许同源的脚本、样式和字体，`connect-src 'none'` 禁止一切 fetch/XHR/WebSocket，`form-action 'none'`、`base-uri 'none'`。样式允许内联（`'unsafe-inline'`）：Base UI 和 CodeMirror 会设置内联样式；而数据外带的通道（图片、字体、请求）都只限同源或被禁止，React 也没有 HTML 注入点，所以 CSS 注入无从利用。“不上传数据”由浏览器强制执行，而不只是承诺；即使将来引入的依赖想联网也会被拦下。开发服务器不加（热更新需要 WebSocket）。已在 `vite preview` 下验证：页面功能正常，主动发起的 fetch（包括同源）被拦截。

## 6. 代理组

- 所有走代理的流量、远程 DNS、规则集下载只有一个入口：`proxy` 选择器。代理组只决定 `proxy` 最终用哪个节点，DNS 和分流规则完全不受影响，原有设计的正确性不变。
- `proxy` 的选项依次是：`auto`（所有“加入代理组”的节点，自动测速）、用户的代理组、（可选）逐个节点、作为代理出口的 tailnet。默认选择可以是 `auto` 或任一代理组；节点多时可以不在 `proxy` 里逐个列出节点。
- 用户代理组是 sing-box 的 `selector`（手动选择）或 `urltest`（自动测速），成员可以是节点、tailnet 或其他代理组。成员按 id 记录，节点改名不会失效；删除节点时会从各组中移除。成员按勾选先后排列，可以手动调整顺序（客户端按此顺序显示，手动选择组没设默认时用第一个）。不做按名称自动匹配：那不是 sing-box 原生能力，生成器实现会让配置和界面的对应关系变复杂。
- 校验：空组（sing-box 会拒绝）、互相包含形成环、名称冲突、测速间隔和容差格式。
- 导入时，源配置里除 `proxy`、`auto` 以外的 `selector`/`urltest` 也会导入；源配置有 `proxy`/`auto` 时，以它们判断哪些节点“加入代理组”。
- 实测和文档说明：组切换成员时，**sing-box 内部发起的连接（例如经 `proxy` 到远程 DNS 的 DoT 连接）总会被中断重建**，只有入站连接受 `interrupt_exist_connections` 控制。所以切换节点后，远程 DNS 会立即改走新节点。

## 界面

- React 19 + shadcn/ui（base-mira 风格，底层 Base UI）+ Tailwind v4。组件源码在 `src/components/ui/`，按需改；Base UI 用 `render` 属性代替 `asChild`，依赖 React 19 把 `ref` 当普通属性传递。
- 第一个标签页是「开始」：说明这套配置要解决的问题和特色，再按步骤指到各标签页；没有保存过标签页时默认打开它。其他标签页的说明文字只讲本页的事，设计理由集中在这里，不在各处重复。
- 顶栏固定：配置切换、管理菜单、检查结果、复制、下载。宽屏（≥1024px）分两栏：左边设置，右边 config.json，页面最宽 1400px。宽屏下页面本身不滚动，设置栏自己滚动（滚动条就在设置栏右侧，而不是在预览的另一边）；窄屏单栏、最宽 768px 居中，config.json 放进「预览」抽屉。检查结果始终在右侧抽屉里。
- 预览会标出改动：每次修改后，用行级 diff（`src/diff.ts`，去掉首尾相同的行后对中间做 LCS）高亮这次改动的行，删除的位置画一根红线；相同的 `{`、`},` 会让区间落到下一个对象内部，所以区间会往上滑到缩进最浅的边界上。第一处改动不在视野内时滚过去；改动分散时，预览标题栏的「N 处改动」列出每一处所在的 JSON 路径（`linePaths`）和内容摘要，点击跳转，也可以逐处上下切换；只是展开卡片时则高亮这一项的整段 JSON。按「所在项的 JSON 块」高亮不够用：MagicDNS 这类开关改的是 DNS 服务器和规则，不在端点块里。
- 深色模式跟随系统（`main.tsx` 切换 `.dark`）。界面全部用 Tailwind 类和 shadcn 组件；`styles.css` 只剩 JSON 高亮、状态颜色、提示条等少量规则。
- 节点、代理组、tailnet 是可折叠卡片（`ItemCard`），表单统一用 `FormField`（标签 + 控件 + 说明，大编辑框的说明放在上方）和 `ToggleRow`（开关）。节点列表和代理组成员都用拖动手柄排序（`src/drag-sort.tsx`），可以一次拖到任意位置，也可聚焦手柄按 ↑/↓。拖动时监听 window 上的指针事件而不是 pointer capture：React 调整顺序会移动 DOM 节点，被捕获的元素一移动捕获就丢了，以前因此每次只能挪一格。
- JSON 编辑框是 CodeMirror 6（`src/code-editor.tsx`）：自写的 JSONC 分词器（`@lezer/json` 不支持注释），行号、括号匹配、撤销、Tab 缩进；解析错误标在出错的位置。`stripComments` 把注释换成等长空白，`JSON.parse` 报的偏移量因此能直接对应原文。域名/IP 列表仍是普通文本框。

## 7. 已知局限

- GFWList 模式下，被墙但没收录进 gfwlist 的域名（例如 `intercom.io`）会拿到污染结果；即使换成干净的 IP，这类域名往往还会被 SNI 阻断，所以正确的补救办法是加入自定义代理域名列表，而不是修 DNS。sing-box 1.14 无法“按 DNS 是否被污染”来决定路由（`override_destination` 已废弃）。
- 规则集从 `raw.githubusercontent.com` 经代理下载；代理未就绪时首次启动会等待。

## 部署

- Cloudflare Workers，只含静态资源（`wrangler.jsonc`），由 Cloudflare 的 Git 集成（Workers Builds）构建部署，GitHub 里不放 Cloudflare 凭据。选 Wrangler 而不是新的 `cf` CLI：`cf` 要求 Vite 6+ 和当时刚发布一天的 `@cloudflare/vite-plugin` beta，不符合“依赖至少发布两周”的约定。
- 按 Cloudflare 默认的方式工作：`main` 是正式分支，推送即上线；其他分支是 Preview，在分支上改、看过 Preview 再合并。版本 tag 只用来发 GitHub Release（测试和三平台 `sing-box check` 通过后，附 `dist/` 压缩包），不影响部署。曾考虑“打 tag 才上线”：Workers Builds 只按分支触发，要么另设 `release` 分支由 CI 推进，要么在 GitHub 里放 Cloudflare 令牌，都比默认方式多一层。
- `compatibility_date` 不能晚于所固定 Wrangler 自带运行时支持的日期；纯静态资源不受它影响。
- `public/_headers` 补上只能用响应头表达的安全设置（`frame-ancestors` 等）。

## 8. 测试

- `test/generate.test.ts`：非 DNS 部分与蓝本逐字段比对（允许的差异逐项列出）；DNS 部分用 `test/dnswalk.ts` 按“模式 × 查询类型 × 域名类别”推演会问哪个服务器、最终怎么回答。
- `test/normalize.ts`：抹平 SFM 重新保存配置时的写法差异（单元素数组写成字符串、省略默认值、时长写成 `24h0m0s` 等）。
- `test/schema.test.ts`：用 1.14.3 官方 JSON schema 校验全部示例配置（schema 由 `sing-box schema` 生成，与源码中的 `docs/schema.json` 一致；大部分定义不允许未知字段，能抓到字段名拼错）。
- CI（`.github/workflows/ci.yml`）：测试、类型检查、构建；然后在 Linux、macOS、Windows 上用官方二进制（`scripts/fetch-sing-box.py` 按发布页公布的 SHA-256 校验）跑 `sing-box check`。Linux 上会覆盖 `auto_redirect` 配置。Android 没有可用的 CI 环境，未覆盖。首次运行（2026-10-15）三个平台全部通过：Linux 30 份通过（含 `full-linux`，`auto_redirect` 被正常接受）、macOS 和 Windows 各 29 份通过。
- `scripts/singbox-check.ts`（`npm run check:singbox`）：为每个节点模板、ShadowTLS 串联、各平台的“功能全开”配置、各代理 DNS 组合生成配置，逐个跑 `sing-box check`。模板里的空密码、UUID、密钥会先填上格式合法的示例值，检查的是字段结构。2026-10-15 用官方 1.14.3（darwin-arm64，SHA-256 与发布页一致）实测全部通过；Linux 配置因 `auto_redirect` 需在 Linux 上检查，去掉该项后其余部分通过。
  - 这次检查发现：Shadowsocks 2022 系列的密码必须是对应长度的 base64 密钥，随便填会导致 sing-box 启动失败（`decode key: illegal base64 data`）。已在模板注释中说明，并在页面校验中提前报错。
- 实际行为通过 Clash API 和 debug 日志在 SFM 中验证；`macOS` 自带的 `dig` 不认识 `HTTPS` 类型名，测试 HTTPS 记录需写成 `TYPE65`。
