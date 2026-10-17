// Share links of every kind, written the way V2Board, Xboard and v2rayN write them; shared by
// the import tests and the samples `sing-box check` runs on.

export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
export const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const vmessLink = (o: object) => `vmess://${b64(JSON.stringify(o))}`;
export const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";

export const LINKS = [
  `ss://${b64url("aes-256-gcm:pass")}@ss.example.org:8388#${encodeURIComponent("🇭🇰 香港 SS")}`,
  `ss://${encodeURIComponent("2022-blake3-aes-128-gcm:AAAAAAAAAAAAAAAAAAAAAA==")}@ss2.example.org:443?uot=1#SS2022`,
  `ss://${b64("chacha20-ietf-poly1305:pw@legacy.example.org:8389")}#Legacy`,
  `ss://${b64url("aes-128-gcm:pw")}@obfs.example.org:80?plugin=${encodeURIComponent("obfs-local;obfs=http;obfs-host=bing.com")}#Obfs`,
  vmessLink({ v: "2", ps: "VMess WS", add: "vm.example.org", port: "443", id: UUID, aid: "0", scy: "auto", net: "ws", type: "none", host: "cdn.example.org", path: "/ws?ed=2048", tls: "tls", sni: "", alpn: "" }),
  vmessLink({ v: "2", ps: "VMess gRPC", add: "vm2.example.org", port: 443, id: UUID, aid: 0, net: "grpc", type: "gun", host: "", path: "svc", tls: "tls", sni: "vm2.example.org" }),
  vmessLink({ v: "2", ps: "VMess TCP", add: "vm3.example.org", port: 80, id: UUID, aid: 0, net: "tcp", type: "none", tls: "" }),
  `vless://${UUID}@re.example.org:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.apple.com&fp=chrome&pbk=jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0&sid=08&type=tcp&headerType=none#Reality`,
  `vless://${UUID}@ws.example.org:443?encryption=none&security=tls&sni=ws.example.org&type=ws&host=ws.example.org&path=%2Fvl#VLESS%20WS`,
  `vless://${UUID}@xh.example.org:443?security=tls&type=xhttp&path=%2Fx#XHTTP`,
  `trojan://p%40ss@tj.example.org:443?sni=tj.example.org&allowInsecure=1&type=grpc&serviceName=tg#Trojan`,
  `hysteria2://pw@hy.example.org:443?sni=hy.example.org&insecure=1&obfs=salamander&obfs-password=ob&mport=20000-30000#Hy2`,
  `hy2://pw@hy3.example.org:443,5000-6000/?sni=hy3.example.org#Hy2%20hop`,
  `hysteria://hy1.example.org:443?protocol=udp&auth=a&peer=hy1.example.org&upmbps=50&downmbps=100&obfs=xplus&obfsParam=secret#Hy1`,
  `tuic://${UUID}:pw@tuic.example.org:443?congestion_control=bbr&udp-relay-mode=native&alpn=h3&sni=tuic.example.org&allow_insecure=1#TUIC`,
  `anytls://pw@any.example.org:443/?sni=any.example.org&insecure=1#AnyTLS`,
  `socks://${b64("user:pass")}@socks.example.org:1080#SOCKS`,
  `wireguard://${encodeURIComponent("YNXtAzepDqRv9H52osJVDQnznT5AL11eVK3jvkVbnHY=")}@wg.example.org:51820?publickey=${encodeURIComponent("Z1XXLsKYkYxuiYjJIkRvtIKFepCYHTgON+GwPq7SOV4=")}&address=10.0.0.2%2F32,fd00%3A%3A2%2F128&reserved=1,2,3&mtu=1280#WG`,
  `ssr://${b64url(`ssr.example.org:443:origin:aes-256-cfb:plain:${b64url("pw")}/?remarks=${b64url("老节点")}`)}`,
];
