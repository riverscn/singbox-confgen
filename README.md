# sing-box 配置生成器

**填入节点，DNS、IPv6 与分流按最佳实践配好。**

**在线使用：<https://sing-box-confgen.riverleaf.dev>**

[![CI](https://github.com/riverscn/singbox-confgen/actions/workflows/ci.yml/badge.svg)](https://github.com/riverscn/singbox-confgen/actions/workflows/ci.yml)
![sing-box 1.14+](https://img.shields.io/badge/sing--box-1.14%2B-blue)
![纯前端](https://img.shields.io/badge/运行-纯浏览器-green)

一份 sing-box 配置用着别扭，问题多半不在节点，而在看不见的地方。这个生成器把这些坑逐一实测、给出对策，你只需要填节点，就能得到一份完整的 `config.json`，导入 SFM、SFI、SFA 或命令行版即可使用。

## 它解决了什么

| 症状 | 原因 | 这里的做法 |
|---|---|---|
| 国内网站被解析到海外，或者被墙的域名打不开 | DNS 没有跟着分流走：国内域名问了海外 DNS，被墙域名拿到污染的地址 | 直连的用本地 DNS，走代理的经代理问远程 DNS；拿不准的域名两边一起问，答出国内 IP 才直连（[DNS 策略](DESIGN.md#2-dns-策略)） |
| 开了代理，部分连接却绕过去或连不上 | 应用优先用 IPv6，而代理服务器没有 IPv6，或者 IPv6 根本不经过 sing-box | 走代理只给 A 记录，连 HTTPS/SVCB 里的 IPv6 提示一起清掉；本机没有 IPv6 时直连也干净地回退到 IPv4（[IPv6 策略](DESIGN.md#3-ipv6-策略)） |
| 网站频繁要求验证、风控 | 出口 IP 在 IPv4 和 IPv6、不同服务器之间漂移 | 走代理的流量始终从同一台服务器、同一个 IPv4 出去 |
| 换了节点，有些东西还走旧线路 | DNS、规则集下载各有各的出口 | 代理流量、远程 DNS、规则集下载共用一个 `proxy` 出口，换节点时一起换（[代理组](DESIGN.md#6-代理组)） |
| 一开全局，家里的 NAS、公司内网就连不上 | 局域网和内网流量也被送进了代理 | 局域网在任何模式下直连；在外面用内置的 Tailscale 连回 tailnet，分域 DNS 拿到内网地址（[Tailscale](DESIGN.md#4-tailscale)） |

每条策略都在日常使用中实测过，生成的配置在 Linux、macOS、Windows 上用官方 `sing-box check` 检查过。完整的设计理由见 [DESIGN.md](DESIGN.md)。

## 三步上手

1. **填节点**：从协议模板添加，或者导入客户端里正在用的配置：sing-box 的 `config.json`（节点和 Tailscale），或 Clash（mihomo）的 YAML（节点和代理组）；也可以导入机场订阅的内容（Clash YAML、明文或 base64 的分享链接、SIP008）。DNS 和分流按这里的策略重写。
2. **选默认模式**：GFWList、Non-CN、Global、Direct 四种都会写进配置，在客户端里随时切换。被墙但不在 gfwlist 里的网站，加进自定义代理域名。
3. **下载 `config.json`**：导入 SFM、SFI、SFA，或运行 `sing-box run -c config.json`。需要 sing-box **1.14** 及以上。

最后一件事：浏览器的“安全 DNS”（DoH）请保持“自动”或关闭。手动指定 DoH 服务商会绕过 sing-box 的 DNS 分流。

## 隐私

- 没有后端。页面的 CSP 禁止发出任何网络请求，设置只保存在当前浏览器的 localStorage 里，可以保存多套配置。
- 下载的 `config.json` 本身也能再导入回来。
- 导入订阅时页面同样不联网：填上订阅地址，页面给出 `curl` 命令和打开链接，由你自己取回内容再粘贴或选择文件。订阅地址不会保存，导入是一次性的，节点更新后需要重新导入。
- 分流策略是固定的一套；需要深度定制时，直接修改生成的 JSON，或者交给 AI 助手（见下一节）。

## 用 AI 助手修改配置

网页只提供一套策略和少量开关。网页里没有的改动（例如加一个 SOCKS 入站、让某个 App 不经过 sing-box），可以交给 Claude Code、Codex、Cursor 等 AI 编程助手。本仓库附带一个 skill：[`sing-box-best-practice`](skills/sing-box-best-practice/SKILL.md)，它告诉助手：

- 这份配置的 DNS 规则、路由规则和规则集分别是什么结构、为什么这样排；
- 哪些约束不能破坏（单一 `proxy` 出口、走代理只给 IPv4、直连优先等），常见修改要同时改哪几处；
- 每个字段都要对照 [sing-box 官方文档](https://sing-box.sagernet.org/configuration/) 查证，先确认你的 sing-box 版本，版本过旧或功能需要新版本时提醒你更新；
- 需要细节时去读本项目的 [DESIGN.md](DESIGN.md) 和 [`src/generate.ts`](src/generate.ts)。

用 [skills CLI](https://www.skills.sh/docs/cli) 安装（需要 Node.js）：

```bash
npx skills add riverscn/singbox-confgen
```

按提示选择你用的助手。常用选项：

| 选项 | 作用 |
|---|---|
| `-g` | 装到用户目录，所有项目都能用（默认只装到当前项目） |
| `-a claude-code` | 只装给指定的助手，例如 `claude-code`、`codex`、`cursor` |
| `--skill sing-box-best-practice` | 只装这一个 skill |
| `-y` | 跳过确认 |

例如不经询问、全局装给 Claude Code：

```bash
npx skills add riverscn/singbox-confgen --skill sing-box-best-practice -g -a claude-code -y
```

之后用 `npx skills update` 更新。装好后，把下载的 `config.json` 交给助手，直接说要什么，例如“加一个 SOCKS 入站，让局域网里的其他设备也能用”，或者“这个网站在 Non-CN 模式下为什么走了代理？”。能在网页里做的改动，助手会建议你回网页改，因为下次从网页下载会覆盖手改的内容。

## 可以设置什么

| 卡片 | 内容 |
|---|---|
| 节点 | 用 JSON 编写（可写注释），从协议模板开始：Hysteria2、VLESS（Vision / Reality）、VMess、Trojan、Shadowsocks、ShadowTLS、TUIC、AnyTLS、Hysteria、NaiveProxy、Snell、SOCKS、HTTP、SSH、Tor，以及 WireGuard、OpenConnect、OpenVPN 端点 |
| 代理组 | 按地区、用途给节点分组：手动选择或自动测速，可嵌套；成员可按名称筛选后一次选中；`proxy` 的默认选择；节点多时可不在 `proxy` 里逐个列出 |
| 分流 | 默认模式；直连域名；代理域名和 IP（适合被墙但不在 gfwlist 里的网站）；DNS 分流（指定域名用本地 DNS、代理 DNS 或自定义的 DNS 服务器解析，例如局域网域名交给路由器 192.168.1.1） |
| Tailscale | 任意多个 tailnet：端点用 JSON 编写（可写注释）；MagicDNS、tailnet 默认 DNS、分域 DNS、额外路由、作为代理出口 |
| 高级 | 目标平台；代理 DNS 服务器（Google / Cloudflare / Quad9，DoT 或 DoH，或用 JSON 自定义任意 DNS 服务器）；ECS；Clash API；Steam、禁止 iCloud 使用 QUIC |

## 开发

```bash
npm install
npm run dev      # 本地开发
npm test         # 规则推演和蓝本比对
npm run build    # 输出到 dist/

# 用真实的 sing-box 检查每个节点模板和功能组合生成的配置
# （下载脚本会用 GitHub 发布页公布的 SHA-256 校验二进制）
SING_BOX=$(python3 scripts/fetch-sing-box.py 1.14.3 /tmp/sing-box) npm run check:singbox
```

推送到 GitHub 后，CI（`.github/workflows/ci.yml`）会跑测试和构建，并在 Linux、macOS、Windows 上分别执行上面的检查。

## 发布到 Cloudflare

站点是一个只含静态资源的 Cloudflare Worker（`wrangler.jsonc`，资源目录 `dist/`），由 Cloudflare 的 Git 集成（Workers Builds）构建和部署，GitHub 里不需要任何 Cloudflare 凭据：

- **`main`**：每次推送（通常是合并 PR）都部署到正式地址。
- **其他分支**：部署为该分支的 Preview，地址在 Worker 的 Previews 页面里，连接了 GitHub 的话也会出现在 PR 上。Preview 地址默认公开（带 `noindex`），需要时可用 Cloudflare Access 保护。
- **版本 tag**（`v1.2.3`，需与 `package.json` 的 `version` 一致）：GitHub Actions 跑完测试和三平台 `sing-box check` 后创建 GitHub Release，附上 `dist/` 的压缩包供自部署。tag 不影响部署。

日常改动在分支上做，看过 Preview 再合并到 `main`。

在 Cloudflare 里设置一次（Workers & Pages → Create → Import a repository，选这个仓库）：

| 设置 | 值 |
| --- | --- |
| Git branch（正式分支） | `main` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy`（默认） |
| Preview command | `npx wrangler preview`（默认） |
| Root directory | `/` |

依赖会自动安装，Node 版本取自 `.node-version`。

在 `main` 上发布一个版本号（GitHub Release）：

```bash
npm version 0.2.0 -m "Release %s"
```

```bash
git push --follow-tags
```

`dist/_headers` 来自 `public/_headers`，给所有响应加上 `frame-ancestors 'none'`、`nosniff` 等安全响应头；页面本身的 CSP 在构建时写进 `index.html`。本地可以用 `npx wrangler dev` 在 Workers 运行时里预览构建结果。

## 自部署

`npm run build` 后，把 `dist/` 放到任意静态托管（Nginx、Caddy、Cloudflare Pages、GitHub Pages 等）。资源用相对路径引用，挂在子路径下也能用。
通过 http 访问时，浏览器可能禁用剪贴板 API，页面会自动退回旧的复制方式。

## 结构

- `src/generate.ts`：配置生成器和校验。
- `src/types.ts`：设置的数据模型；`src/defaults.ts`：默认值；`src/templates.ts`：节点协议模板。
- `src/legacy.ts`：把旧版（表单）保存的服务器迁移为 JSON 节点。
- `src/importer.ts`：从现有 sing-box 配置导入节点和 Tailscale。
- `src/clash.ts`：从 Clash（mihomo）配置导入节点和代理组。
- `src/subscription.ts`：识别订阅内容（分享链接、base64、SIP008），把分享链接读成 Clash 的代理字段，再交给 `src/clash.ts` 转换；解析规则参照 mihomo 和 Sub-Store。
- `src/import-dialog.tsx`：导入对话框（文件、粘贴、订阅地址的取回方式）。
- `src/App.tsx`：界面；`src/storage.ts`：本地保存和导入时的兼容处理。
- `test/generate.test.ts`：
  - 用一份“个人配置”还原蓝本（`test/fixtures/tiger-baseline.json`，已匿名化）的非 DNS 部分；
  - 默认配置不含任何个人设置；
  - DNS 部分用 `test/dnswalk.ts` 按“模式 × 查询类型 × 域名类别”推演会问哪个服务器、最终怎么回答。
- `test/normalize.ts`：抹平 SFM 重新保存配置时的写法差异（单元素数组、默认值、时长格式）。
- `test/samples.ts`：覆盖全部节点模板和功能、平台组合的示例配置，供 schema 测试和 `sing-box check` 共用。
- `test/schema.test.ts`：用 sing-box 1.14.3 官方 JSON schema（`test/fixtures/sing-box-1.14.3.schema.json`）校验所有示例配置。
- `test/storage.test.ts`：多套配置的存储和旧数据迁移。
- `test/subscription.test.ts`：各协议分享链接、SIP008 和 base64 订阅的导入，以及生成的配置符合 schema。
- `skills/sing-box-best-practice/`：给 AI 编程助手用的 skill，说明如何修改生成的配置。
- `scripts/`：下载并校验官方 sing-box（`fetch-sing-box.py`），对示例配置跑 `sing-box check`（`singbox-check.ts`）。
