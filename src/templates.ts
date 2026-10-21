// Node templates for every proxy protocol sing-box 1.14 offers as an outbound or endpoint.
// Bodies are JSON with comments; the generator fills in `tag`. Field names follow
// https://sing-box.sagernet.org/configuration/outbound/ and /endpoint/.

export interface NodeTemplate {
  id: string;
  label: string;
  /** Suggested tag prefix for new nodes. */
  tagPrefix: string;
  body: string;
}

/** Types that are configured under `endpoints` rather than `outbounds`. */
export const ENDPOINT_TYPES = ["wireguard", "openconnect", "openvpn-client"];

/** Every type accepted as a node. */
export const NODE_TYPES = [
  "hysteria2",
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "shadowtls",
  "tuic",
  "anytls",
  "hysteria",
  "naive",
  "snell",
  "socks",
  "http",
  "ssh",
  "tor",
  ...ENDPOINT_TYPES,
];

/** Types that need a top-level `server`. */
export const NEEDS_SERVER = NODE_TYPES.filter((t) => !["tor", "wireguard", "openvpn-client"].includes(t));

/** Fields (at any depth) that must not be left empty, e.g. `tls.reality.public_key`. */
export const SECRET_FIELDS = ["password", "uuid", "psk", "private_key", "public_key", "auth_str"];

export const TEMPLATES: NodeTemplate[] = [
  {
    id: "hysteria2",
    label: "Hysteria2",
    tagPrefix: "hy2",
    body: `{
  "type": "hysteria2",
  "server": "server.example.com",
  "server_port": 443,
  // 端口跳跃（可选）：填了 server_ports 后 server_port 会被忽略
  // "server_ports": ["20000:50000"],
  // "hop_interval": "30s",
  "up_mbps": 50,
  "down_mbps": 300,
  "password": "",
  // 混淆（可选，需与服务端一致）
  // "obfs": { "type": "salamander", "password": "" },
  "tls": {
    "enabled": true,
    "server_name": "server.example.com"
  }
}`,
  },
  {
    id: "vless-vision",
    label: "VLESS（Vision + TLS）",
    tagPrefix: "vless",
    body: `{
  "type": "vless",
  "server": "server.example.com",
  "server_port": 443,
  "uuid": "",
  "flow": "xtls-rprx-vision",
  "tls": {
    "enabled": true,
    "server_name": "server.example.com",
    "utls": { "enabled": true, "fingerprint": "chrome" }
  }
}`,
  },
  {
    id: "vless-reality",
    label: "VLESS（Vision + Reality）",
    tagPrefix: "reality",
    body: `{
  "type": "vless",
  "server": "server.example.com",
  "server_port": 443,
  "uuid": "",
  "flow": "xtls-rprx-vision",
  "tls": {
    "enabled": true,
    // 伪装的目标网站，需与服务端配置一致
    "server_name": "www.microsoft.com",
    "utls": { "enabled": true, "fingerprint": "chrome" },
    "reality": {
      "enabled": true,
      "public_key": "",
      "short_id": ""
    }
  }
}`,
  },
  {
    id: "vmess-ws",
    label: "VMess（WebSocket + TLS）",
    tagPrefix: "vmess",
    body: `{
  "type": "vmess",
  "server": "server.example.com",
  "server_port": 443,
  "uuid": "",
  "security": "auto",
  "alter_id": 0,
  "tls": {
    "enabled": true,
    "server_name": "server.example.com"
  },
  "transport": {
    "type": "ws",
    "path": "/",
    "headers": { "Host": "server.example.com" }
  }
}`,
  },
  {
    id: "trojan",
    label: "Trojan",
    tagPrefix: "trojan",
    body: `{
  "type": "trojan",
  "server": "server.example.com",
  "server_port": 443,
  "password": "",
  "tls": {
    "enabled": true,
    "server_name": "server.example.com"
  }
  // 使用 WebSocket 等传输层时（可选）：
  // "transport": { "type": "ws", "path": "/" }
}`,
  },
  {
    id: "shadowsocks",
    label: "Shadowsocks",
    tagPrefix: "ss",
    body: `{
  "type": "shadowsocks",
  "server": "server.example.com",
  "server_port": 8388,
  // 推荐 2022 系列：2022-blake3-aes-128-gcm / 2022-blake3-aes-256-gcm / 2022-blake3-chacha20-poly1305
  "method": "2022-blake3-aes-128-gcm",
  // 2022 系列的密码是 base64 编码的密钥：aes-128 为 16 字节，aes-256 和 chacha20 为 32 字节，
  // 可用 sing-box generate rand --base64 16 生成；多用户时写成 "服务器密钥:用户密钥"
  "password": ""
  // 配合 ShadowTLS 使用时，把 ShadowTLS 节点的标签填到这里：
  // "detour": "shadowtls-1"
}`,
  },
  {
    id: "shadowtls",
    label: "ShadowTLS",
    tagPrefix: "shadowtls",
    body: `{
  // ShadowTLS 只负责伪装，需要再加一个 Shadowsocks 节点，在其中写 "detour": "<本节点标签>"。
  // 本节点通常不需要加入默认代理组。
  "type": "shadowtls",
  "server": "server.example.com",
  "server_port": 443,
  "version": 3,
  "password": "",
  "tls": {
    "enabled": true,
    // 伪装的目标网站，需与服务端配置一致
    "server_name": "www.microsoft.com",
    "utls": { "enabled": true, "fingerprint": "chrome" }
  }
}`,
  },
  {
    id: "tuic",
    label: "TUIC",
    tagPrefix: "tuic",
    body: `{
  "type": "tuic",
  "server": "server.example.com",
  "server_port": 443,
  "uuid": "",
  "password": "",
  "congestion_control": "bbr",
  "udp_relay_mode": "native",
  "tls": {
    "enabled": true,
    "server_name": "server.example.com",
    "alpn": ["h3"]
  }
}`,
  },
  {
    id: "anytls",
    label: "AnyTLS",
    tagPrefix: "anytls",
    body: `{
  "type": "anytls",
  "server": "server.example.com",
  "server_port": 443,
  "password": "",
  "tls": {
    "enabled": true,
    "server_name": "server.example.com"
  }
}`,
  },
  {
    id: "hysteria",
    label: "Hysteria（v1）",
    tagPrefix: "hysteria",
    body: `{
  "type": "hysteria",
  "server": "server.example.com",
  "server_port": 443,
  "up_mbps": 50,
  "down_mbps": 300,
  "auth_str": "",
  // 混淆密码（可选，需与服务端一致）
  // "obfs": "",
  "tls": {
    "enabled": true,
    "server_name": "server.example.com"
    // ALPN 需与服务端一致，例如：
    // "alpn": ["h3"]
  }
}`,
  },
  {
    id: "naive",
    label: "NaiveProxy",
    tagPrefix: "naive",
    body: `{
  "type": "naive",
  "server": "server.example.com",
  "server_port": 443,
  "username": "",
  "password": "",
  "tls": {
    "enabled": true,
    "server_name": "server.example.com"
  }
}`,
  },
  {
    id: "snell",
    label: "Snell",
    tagPrefix: "snell",
    body: `{
  "type": "snell",
  "server": "server.example.com",
  "server_port": 443,
  "version": 4,
  "psk": ""
  // 混淆（可选，需与服务端一致）：
  // "obfs_mode": "http",
  // "obfs_host": "www.bing.com"
}`,
  },
  {
    id: "socks",
    label: "SOCKS5",
    tagPrefix: "socks",
    body: `{
  "type": "socks",
  "server": "127.0.0.1",
  "server_port": 1080,
  "version": "5"
  // 需要认证时：
  // "username": "",
  // "password": ""
}`,
  },
  {
    id: "http",
    label: "HTTP 代理",
    tagPrefix: "http",
    body: `{
  "type": "http",
  "server": "127.0.0.1",
  "server_port": 8080
  // 需要认证时：
  // "username": "",
  // "password": "",
  // HTTPS 代理：
  // "tls": { "enabled": true, "server_name": "proxy.example.com" }
}`,
  },
  {
    id: "ssh",
    label: "SSH",
    tagPrefix: "ssh",
    body: `{
  "type": "ssh",
  "server": "server.example.com",
  "server_port": 22,
  "user": "root",
  // 密码或私钥二选一
  "password": ""
  // "private_key_path": "$HOME/.ssh/id_ed25519",
  // 建议固定服务器公钥，防止中间人：
  // "host_key": ["ssh-ed25519 AAAA..."]
}`,
  },
  {
    id: "tor",
    label: "Tor",
    tagPrefix: "tor",
    body: `{
  // 需要本机安装 tor（只适用于桌面命令行版），速度较慢，通常不加入自动测速
  "type": "tor",
  "executable_path": "/usr/bin/tor",
  "data_directory": "$HOME/.cache/tor"
}`,
  },
  {
    id: "wireguard",
    label: "WireGuard（端点）",
    tagPrefix: "wg",
    body: `{
  // 端点：生成器会把它放进 endpoints
  "type": "wireguard",
  "address": ["172.16.0.2/32"],
  "private_key": "",
  "mtu": 1408,
  "peers": [
    {
      "address": "server.example.com",
      "port": 51820,
      "public_key": "",
      "allowed_ips": ["0.0.0.0/0", "::/0"]
    }
  ]
}`,
  },
  {
    id: "openconnect",
    label: "OpenConnect（端点）",
    tagPrefix: "oc",
    body: `{
  // 端点：兼容 Cisco AnyConnect 等，生成器会把它放进 endpoints
  "type": "openconnect",
  "server": "vpn.example.com",
  // 可选：anyconnect / gp / fortinet / f5 / pulse / nc
  "flavor": "anyconnect",
  "username": "",
  "password": ""
}`,
  },
  {
    id: "openvpn-client",
    label: "OpenVPN（端点）",
    tagPrefix: "ovpn",
    body: `{
  // 端点：生成器会把它放进 endpoints。证书等字段请对照 .ovpn 文件填写，
  // 详见 https://sing-box.sagernet.org/zh/configuration/endpoint/openvpn-client/
  "type": "openvpn-client",
  "server": "vpn.example.com",
  "server_port": 1194,
  "network": "udp",
  "username": "",
  "password": "",
  "tls": {
    "certificate_path": "ca.crt"
  }
}`,
  },
];
