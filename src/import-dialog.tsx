// Where an import starts: a config file, or what a subscription URL returns. The page makes no
// network requests, so for a subscription it only shows how to fetch it (a link to open, a curl
// command) and takes the content pasted back.

import { useId, useRef, useState } from "react";
import { Check, Copy, ExternalLink, FileUp } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "./clipboard";
import { importConfig, type ImportResult } from "./importer";
import { curlCommand } from "./subscription";

/** The subscription URL if it is one; the dialog never requests it. */
function subscriptionUrl(text: string): URL | null {
  try {
    const u = new URL(text.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export function ImportDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A parsed import, a name for the profile it makes, and where it came from (`从「a.yaml」`). */
  onImport: (result: ImportResult, name: string, source: string) => void;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sub = subscriptionUrl(url);

  const reset = () => {
    setUrl("");
    setText("");
    setError("");
    setCopied(false);
  };
  const run = (content: string, name: string, source: string) => {
    let result: ImportResult;
    try {
      result = importConfig(content);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    props.onOpenChange(false);
    reset();
    props.onImport(result, name, source);
  };
  const subName = sub ? sub.hostname : "";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) run(text, subName || "导入的订阅", sub ? `从 ${sub.hostname} 的订阅` : "从粘贴的内容");
          }}
        >
          <DialogHeader>
            <DialogTitle>从配置或订阅新建</DialogTitle>
            <DialogDescription>
              支持 sing-box 的 JSON、Clash（mihomo）的 YAML，以及订阅返回的内容：分享链接（ss、vmess、vless、trojan、hysteria2、tuic、anytls 等，明文或 base64）和 SIP008。导入后新建一套配置，当前配置不受影响。
            </DialogDescription>
          </DialogHeader>

          <Field>
            <FieldLabel htmlFor={`${id}-url`}>订阅地址（可选）</FieldLabel>
            <Input
              id={`${id}-url`}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setCopied(false);
              }}
              placeholder="https://"
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
            />
            <FieldDescription>本页面不联网，不会访问也不会保存这个地址。填上后，按下面任一方式取得订阅内容，再粘贴到下方。</FieldDescription>
            {sub && (
              <div className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/60 p-3 text-xs">
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 font-mono break-all">{curlCommand(sub.href)}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="复制命令"
                    onClick={async () => setCopied(await copyText(curlCommand(sub.href)))}
                  >
                    {copied ? <Check /> : <Copy />}
                  </Button>
                </div>
                <p className="text-muted-foreground">
                  在终端运行这条命令（以 Clash 客户端的身份请求，多数面板会返回带代理组的 Clash 配置），然后选择得到的 subscription.yaml，或把内容粘贴进来。
                </p>
                <p className="text-muted-foreground">
                  也可以
                  <a href={sub.href} target="_blank" rel="noreferrer noopener" className="mx-1 inline-flex items-center gap-0.5 text-foreground underline underline-offset-2">
                    在新标签页打开
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                  ，全选复制页面上的内容。浏览器打开时面板通常返回 base64 编码的分享链接，只有节点、没有代理组；V2Board、Xboard 的地址后加上 <code className="font-mono">&amp;flag=meta</code> 可以拿到 Clash 配置。
                </p>
              </div>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor={`${id}-text`}>粘贴内容</FieldLabel>
            <Textarea
              id={`${id}-text`}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError("");
              }}
              rows={6}
              placeholder={"proxies:\n  - name: …\n\n或者 vless://…、ss://…，或一整段 base64"}
              spellCheck={false}
              aria-invalid={!!error}
              className="field-sizing-fixed max-h-60 font-mono text-base break-all md:text-xs/relaxed"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </Field>

          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
              <FileUp />
              选择文件…
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <DialogClose render={<Button type="button" variant="ghost" />}>取消</DialogClose>
              <Button type="submit" disabled={!text.trim()}>
                导入
              </Button>
            </div>
          </DialogFooter>
        </form>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json,application/yaml,.yaml,.yml,text/plain,.txt"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) run(await f.text(), f.name.replace(/\.[^.]*$/, "") || subName || "导入的配置", `从「${f.name}」`);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
