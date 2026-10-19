---
name: sing-box-best-practice
description: Modify a sing-box config.json made by singbox-confgen (the "sing-box 配置生成器" with DNS, IPv6 and routing best practices) without breaking its DNS, IPv6 and routing design. Use when the user wants to change, extend, debug or explain such a config — add domains, rules, nodes, proxy groups, DNS servers, Tailscale, adapt it to a platform — or asks why it is built the way it is. Also useful for any sing-box 1.14+ config that splits traffic for users in China (gfwlist / geosite-cn, DNS pollution, IPv6 leaks).
---

# sing-box 最佳实践配置的修改

用户手里的 `config.json` 多半出自 [sing-box 配置生成器](https://github.com/riverscn/singbox-confgen)。这份配置的 DNS、IPv6 和分流规则相互依赖（规则顺序、`evaluate`/`respond` 的配合、IPv6 拒绝规则的排除项），随手改一条可能悄悄出错，而不会报错。本 skill 说明它的结构、不能破坏的约束，以及常见修改的正确做法。

## 先做这三件事

1. **确认用户的 sing-box 版本。** 生成的配置需要 **1.14 及以上**（用到了 `evaluate`、`respond`、`race`、`speculative`、`neighbor_domain`、`http_clients`、`preferred_by` 等 1.13/1.14 才有的功能）。
   - 命令行版：`sing-box version`。
   - 图形客户端：SFM（macOS）、SFI（iOS）、SFA（Android）在设置或“关于”里显示内核版本；问用户，不要猜。
   - 版本低于 1.14：直接告诉用户这份配置无法加载，先更新客户端或内核（[发布页](https://github.com/SagerNet/sing-box/releases)），不要为了迁就旧版本去拆掉这些功能，那会破坏整个 DNS 设计。
   - 用户要的功能需要更新的版本，或者旧写法已被废弃时，提醒用户更新，并说明是哪个版本引入或废弃的。
2. **以官方文档为准，查证后再写。** 每个字段、规则项、动作都先到 [sing-box 官方配置文档](https://sing-box.sagernet.org/configuration/) 核对，不要凭记忆。sing-box 迭代快，字段经常新增、改名、废弃。
   - 文档页上标有“Since sing-box 1.x.0”的字段，确认用户的版本已经支持。
   - 文档反映最新版本（可能含测试版）。用户版本较旧时，对照 [更新日志](https://sing-box.sagernet.org/changelog/)、[废弃功能](https://sing-box.sagernet.org/deprecated/) 和 [迁移指南](https://sing-box.sagernet.org/migration/)。
   - 常用页面：[DNS 规则](https://sing-box.sagernet.org/configuration/dns/rule/)、[DNS 规则动作](https://sing-box.sagernet.org/configuration/dns/rule_action/)、[DNS 服务器](https://sing-box.sagernet.org/configuration/dns/server/)、[路由规则](https://sing-box.sagernet.org/configuration/route/rule/)、[路由规则动作](https://sing-box.sagernet.org/configuration/route/rule_action/)、[规则集](https://sing-box.sagernet.org/configuration/rule-set/)、[Tailscale 端点](https://sing-box.sagernet.org/configuration/endpoint/tailscale/)、[HTTP 客户端](https://sing-box.sagernet.org/configuration/shared/http-client/)。
3. **判断该不该手改。** 生成器把设置保存在用户浏览器里，下次从网页下载会覆盖手改的内容。网页能做到的（见下表），优先让用户在网页里改；网页做不到的才手改，并提醒用户记下手改的部分。

| 网页里就能改 | 位置 |
|---|---|
| 节点（18 种协议）、是否加入代理组 | 节点 |
| 代理组（手动选择 / 自动测速，可嵌套）、`proxy` 的默认选择 | 代理组 |
| 默认模式；直连域名/IP；代理域名/IP；“域名/IP → 指定节点或代理组”的规则 | 分流 |
| Tailscale：MagicDNS、默认 DNS、分域 DNS、额外路由、作为代理出口、出口节点 | Tailscale |
| 目标平台、代理 DNS（预设或自定义 JSON）、ECS、Clash API、Steam、禁止 iCloud QUIC | 设置 |

手改的内容想看准确写法时，一个好办法是让用户在网页里新建一套配置，只做这一项改动，下载后和原配置对比。

## 认出这份配置

出自生成器的配置有这些特征：

- `outbounds` 第一项是 `selector`，标签 `proxy`；第二项是 `urltest`，标签 `auto`；最后是 `direct`。
- `dns.servers` 有 `local`（`type: local`）和 `remote`（经 `detour: proxy`），可能还有 `<tailnet>-dns` 和 DNS 分流用的 `dns-rule-<序号>`。
- `route.rule_set` 里有 `geoip-cn`、`geosite-geolocation-cn`、`gfwlist`、`telegram-ip`、`gfwlist-custom-domains`、`gfwlist-custom-ips`、`custom-direct-domains`。
- 规则里大量使用 `clash_mode`，模式名是 `Direct`、`GFWList`、`Non-CN`、`Global`。
- `http_clients` 有 `rule-set-download`（`detour: proxy`）。

不是这类配置时，下面的“设计原则”依然适用，但标签和规则顺序不要照搬。

## 设计原则（修改时不能破坏）

完整理由见 [DESIGN.md](https://github.com/riverscn/singbox-confgen/blob/main/DESIGN.md)。

1. **一个出口 `proxy`。** 走代理的流量、远程 DNS（`remote` 的 `detour`）、规则集下载（`rule-set-download`）都经过 `proxy`。新的代理组或节点要放进 `proxy`（或它的成员组）里，而不是绕开它另设出口；否则换节点时 DNS 和下载不会跟着换。
2. **直连用本地 DNS，走代理用远程 DNS。** 不要加入国内 DoH（阿里、腾讯等）：国内没有不经代理就干净的 DNS，换了只是多一个依赖。
3. **走代理的域名只给 IPv4。** 这类域名的 `AAAA`、`HTTPS`、`SVCB` 一律返回空（`predefined` + `NOERROR`）。新增“走代理”的域名时，必须同时进入这条规则覆盖的范围，否则会出现 IPv6 假连通（TUN 下应用不会从 IPv6 回退到 IPv4）和出口漂移。不要添加“走代理也用 IPv6”，原因见 DESIGN.md 第 3 节。
4. **规则顺序有意义。** DNS 和路由规则都是第一条匹配的生效，顺序见下一节。插入新规则前先找准位置。
5. **直连优先。** 同一域名或 IP 同时在直连和代理里时，直连生效；DNS 和路由两边都按这个优先级写。
6. **局域网永远直连。** `ip_is_private`、`.local`/`.lan`/`.home.arpa` 等本地域名在任何模式下直连。
7. **TUN 保留 IPv6 地址。** 不要删掉 `tun-in` 的 IPv6 地址，否则各平台行为会不一致，IPv6 流量可能绕过 sing-box。
8. **平台专属选项要小心。** `auto_redirect` 只能用于 Linux，其他平台会报错无法加载。

## 结构速查

### DNS 规则顺序（`dns.rules`）

1. Tailscale：分域 DNS 域名 → `<tailnet>-dns`；MagicDNS（`preferred_by`）→ `<tailnet>-dns`。
2. （有 DNS 分流时）`custom-dns-domains` 里的域名（局域网域名除外，它们所有记录照常返回）：会走代理的（代理域名、规则域名，或不确定直连的）IPv6 类查询返回空；确定直连且本机没有公网 IPv6 时 `AAAA` 返回空；然后按 DNS 规则顺序 → 各自的服务器（`local`、`remote` 或 `dns-rule-<序号>`）。排在局域网规则之前，所以可以把 `.lan` 和设备名（`domain_regex: ^[^.]+$`）交给路由器。
2b. `preferred_by: local`、本地域名 → `local`。
3. （有代理域名或规则时）代理域名、规则域名：IPv6 类查询返回空；其余 → `remote`。条件都带“不是 Direct 模式、不在直连列表”。
4. 直连流量：本机没有公网 IPv6 时 `AAAA` 返回空；其余 → `local`。“直连流量”由一个 `or` 判断，覆盖 Direct 模式、直连列表、GFWList 模式下不在 gfwlist 的、Non-CN 模式下在 `geosite-geolocation-cn` 的。
5. Non-CN 模式下的其余域名：`evaluate` 问 `local`（`local-answer`，超时 500ms）；返回内网 IP 或国内 IP 时 `respond`（`race: true`），没有公网 IPv6 时国内 `AAAA` 返回空。
6. 走代理：IPv6 类查询返回空；`evaluate` 问 `remote`（`speculative: true`，和第 5 步并行）；`respond`；兜底 `SERVFAIL`。

`dns.final` 是 `remote`。

### 路由规则顺序（`route.rules`）

1. 本机没有公网 IPv6 时，在握手前拒绝直连的国内 IPv6（`reject`，`no_drop: true`），让应用回退到 IPv4；排除 tailnet、53 端口、代理列表和规则里写明的 IP。
2. `sniff`；DNS 流量 `hijack-dns`；（可选）禁止 iCloud QUIC。
3. Tailscale：`preferred_by` → 端点；额外路由 → 端点。
4. 本地域名、`ip_is_private` → `direct`。
5. Direct 模式 → `direct`；非 Global 模式下的直连列表（`custom-direct-domains`、`custom-direct-ips`）→ `direct`。
6. 用户规则：域名/IP → 指定节点或代理组，按列表顺序。
7. 代理列表（`gfwlist-custom-domains`、`gfwlist-custom-ips`）→ `proxy`。
8. GFWList 模式下不在 gfwlist（含 Telegram IP 和自定义代理）的 → `direct`。
9. Non-CN 模式下国内域名、内网、国内 IP → `direct`。
10. Global 模式 → `proxy`。

`route.final` 是 `proxy`。

### 规则集

| 标签 | 来源 | 用途 |
|---|---|---|
| `geoip-cn`、`geosite-geolocation-cn` | SagerNet 官方 | Non-CN 判断，IPv6 拒绝规则 |
| `gfwlist` | Dreista/sing-box-rule-set-cn | GFWList 模式 |
| `telegram-ip` | 内联 | GFWList 模式下按 IP 走代理 |
| `gfwlist-custom-domains`、`gfwlist-custom-ips` | 内联 | 自定义代理（也并入 GFWList 判断） |
| `custom-direct-domains`、`custom-direct-ips` | 内联 | 自定义直连 |
| `custom-rule-domains` | 内联 | 只给 DNS 用：规则里的域名，按走代理解析 |
| `custom-rule-ips` | 内联 | 只给 IPv6 拒绝规则用：规则里的 IP，放行 |
| `custom-dns-domains` | 内联 | 只给 DNS 用：DNS 分流里的所有域名，套用 IPv6 策略 |

内联规则集为空时写成永不匹配的 `{"domain_regex": ["a^"]}`。

## 常见修改

能在网页里做的，先建议网页。必须手改时：

**加一个“始终走代理”的域名**
1. 写进 `gfwlist-custom-domains`（替换掉 `a^` 占位）。
2. 检查 DNS 规则里是否已有引用 `gfwlist-custom-domains` 的两条规则（IPv6 类返回空，然后 → `remote`）。没有就按“结构速查”第 3 步补上，并在第 4 步“直连流量”判断的 Non-CN 分支里加上 `{"rule_set": "gfwlist-custom-domains", "invert": true}`。
3. 检查路由规则里是否已有 `rule_set: [gfwlist-custom-domains, gfwlist-custom-ips] → proxy`，没有就加在直连列表规则之后、GFWList 规则之前。

**加一个“始终直连”的域名**：写进 `custom-direct-domains`。DNS 和路由规则已经引用它，不用改规则。

**把某些域名交给指定节点**：在路由规则第 6 步的位置加一条规则；域名同时放进 `custom-rule-domains`，并确保 DNS 第 3 步引用了它（按走代理解析：只给 IPv4，问 `remote`）。远程 DNS 仍然经 `proxy`，不经这个节点。规则里有 IP 时，也放进 `custom-rule-ips`，并在 IPv6 拒绝规则里排除。

**让某些域名用指定的 DNS 解析**：网页的“DNS 分流”可以做。手改时在 DNS 第 2 步的位置加 `domain…` → 服务器的 `route` 规则，域名同时放进 `custom-dns-domains`，保证它前面的三条 IPv6 规则覆盖到；自定义服务器加进 `dns.servers`，直连访问时不写 `detour`（不能写 `direct`）。这只改解析者，流量走向仍由路由规则决定。

**加节点**：放进 `outbounds`（WireGuard、OpenConnect、OpenVPN 是端点，放进 `endpoints`）；没写 `domain_resolver` 时加上 `"domain_resolver": "local"`（节点服务器是直连访问的）；要参与自动测速就加进 `auto` 的 `outbounds`。

**加代理组**：`selector` 或 `urltest`，加进 `proxy` 的 `outbounds`。组不能为空，不能互相包含成环。

**换远程 DNS**：只改 `remote` 服务器本身，保持 `tag: remote` 和 `detour: proxy`。默认不发 ECS（走代理时 CDN 应该就近代理服务器）。

**排查“某网站打不开”**：先判断它在当前模式下该直连还是走代理，再看 DNS 走到了哪一步。GFWList 模式下被墙但不在 gfwlist 里的网站，正确做法是加进代理域名，而不是修 DNS（这类域名往往还会被 SNI 阻断）。

## 改完之后

1. `sing-box check -c config.json`：必须通过。
2. `sing-box format -c config.json -w`：可选，统一格式。
3. 用户报告行为不对时，看 debug 日志（`log.level` 改成 `debug`）或通过 Clash API 查看连接走向。
4. 告诉用户改了什么、为什么这样改，以及下次从网页下载会覆盖这些改动。

## 深入参考

需要确切的生成逻辑时，读本项目源码：

- [DESIGN.md](https://github.com/riverscn/singbox-confgen/blob/main/DESIGN.md)：每条策略的理由和实测结论，包括已知局限。
- [src/generate.ts](https://github.com/riverscn/singbox-confgen/blob/main/src/generate.ts)：生成逻辑。`dnsRules`、`routeRules`、`ruleSets`、`outbounds` 分别对应上面的各部分，注释说明了每条规则的意图。
- [test/dnswalk.ts](https://github.com/riverscn/singbox-confgen/blob/main/test/dnswalk.ts)：按“模式 × 查询类型 × 域名类别”推演 DNS 结果，可用来理解规则的实际效果。

源码对应生成器的最新版本。用户的配置是旧版本生成的时，以用户手里的配置为准。
