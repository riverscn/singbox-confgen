# sing-box 配置生成器

纯前端的 sing-box 配置生成器：在网页里填写代理服务器和少量偏好，实时生成完整的 `config.json`，可以复制或下载。

- 需要 sing-box **1.14** 及以上（Apple 平台的 SFM/SFI、Android 的 SFA，或 Linux/Windows 命令行版）。
- 没有后端，运行时不发出任何网络请求；设置只保存在当前浏览器的 localStorage 里，可以保存多套配置。
- 可以从现有的 sing-box 配置（例如客户端里正在用的 `config.json`）导入节点和 Tailscale 设置，也可以从 Clash（mihomo）的 YAML 配置导入节点和代理组；DNS 和分流规则由本工具生成。下载的 `config.json` 本身也能再导入回来。
- 分流策略是一套固定、经过实测的规则（四种模式：GFWList、Non-CN、Global、Direct），设计理由见 [DESIGN.md](DESIGN.md)。需要深度定制时，直接修改生成的 JSON。

## 可以设置什么

| 卡片 | 内容 |
|---|---|
| 节点 | 用 JSON 编写（可写注释），从协议模板开始：Hysteria2、VLESS（Vision / Reality）、VMess、Trojan、Shadowsocks、ShadowTLS、TUIC、AnyTLS、Hysteria、NaiveProxy、Snell、SOCKS、HTTP、SSH、Tor，以及 WireGuard、OpenConnect、OpenVPN 端点 |
| 代理组 | 按地区、用途给节点分组：手动选择或自动测速，可嵌套；成员可按名称筛选后一次选中；`proxy` 的默认选择；节点多时可不在 `proxy` 里逐个列出 |
| 分流 | 默认模式；直连域名；代理域名和 IP（适合被墙但不在 gfwlist 里的网站） |
| Tailscale | 任意多个 tailnet：端点用 JSON 编写（可写注释）；MagicDNS、tailnet 默认 DNS、分域 DNS、额外路由、作为代理出口 |
| 高级 | 目标平台；代理 DNS 服务器（Google / Cloudflare / Quad9，DoT 或 DoH，或用 JSON 自定义任意 DNS 服务器）；ECS；Clash API；Steam、禁止 iCloud 使用 QUIC |

## 浏览器设置建议

浏览器的“安全 DNS”（DoH）请保持“自动”或关闭。手动指定 DoH 服务商会绕过 sing-box 的 DNS 分流。

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
- `src/App.tsx`：界面；`src/storage.ts`：本地保存和导入时的兼容处理。
- `test/generate.test.ts`：
  - 用一份“个人配置”还原蓝本（`test/fixtures/tiger-baseline.json`，已匿名化）的非 DNS 部分；
  - 默认配置不含任何个人设置；
  - DNS 部分用 `test/dnswalk.ts` 按“模式 × 查询类型 × 域名类别”推演会问哪个服务器、最终怎么回答。
- `test/normalize.ts`：抹平 SFM 重新保存配置时的写法差异（单元素数组、默认值、时长格式）。
- `test/samples.ts`：覆盖全部节点模板和功能、平台组合的示例配置，供 schema 测试和 `sing-box check` 共用。
- `test/schema.test.ts`：用 sing-box 1.14.3 官方 JSON schema（`test/fixtures/sing-box-1.14.3.schema.json`）校验所有示例配置。
- `test/storage.test.ts`：多套配置的存储和旧数据迁移。
- `scripts/`：下载并校验官方 sing-box（`fetch-sing-box.py`），对示例配置跑 `sing-box check`（`singbox-check.ts`）。
