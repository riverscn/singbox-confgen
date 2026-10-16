import { Fragment, useEffect, useId, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import type { Platform, Profile, ProxyGroup, ProxyNode, RemoteDnsChoice, RemoteDnsProtocol, Settings, Tailnet } from "./types";
import { TEMPLATES } from "./templates";
import { REMOTE_DNS, generateConfig, nodeObject, parseDomainList, parseRuleList, tailnetEndpoint, validate, type Issue } from "./generate";
import { freshTag, newGroup, newNode, newTailnet, randomSecret } from "./defaults";
import { clearStore, defaultStore, loadStore, newSavedProfile, saveStore, type Store } from "./storage";
import { fitImport, importSingBoxConfig, type ImportResult } from "./importer";
import { useDialogs } from "./dialog";
import { CodeEditor } from "./code-editor";
import { useDragSort } from "./drag-sort";
import { changedLines, linePaths, type LineRange } from "./diff";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Copy,
  CopyPlus,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  FileUp,
  Info,
  GripVertical,
  Pencil,
  RefreshCw,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  WrapText,
} from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; self-hosted http:// pages land here.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Label, control and hint; `children` gets the id to put on the control. Large controls (editors,
 * lists) set `hintAbove` so the hint is read before them.
 */
function FormField(props: { label: ReactNode; hint?: ReactNode; hintAbove?: boolean; wide?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  const hint = props.hint && <FieldDescription className={props.hintAbove ? "-mt-1" : undefined}>{props.hint}</FieldDescription>;
  return (
    <Field className={props.wide ? "sm:col-span-2" : undefined}>
      <FieldLabel id={`${id}-label`} htmlFor={id}>
        {props.label}
      </FieldLabel>
      {props.hintAbove && hint}
      {props.children(id)}
      {!props.hintAbove && hint}
    </Field>
  );
}

/** A switch with a title and an explanation, the whole row clickable. */
function ToggleRow(props: { checked: boolean; onChange: (v: boolean) => void; title: ReactNode; description?: ReactNode; wide?: boolean }) {
  const id = useId();
  return (
    <Field orientation="horizontal" className={props.wide ? "sm:col-span-2" : undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{props.title}</FieldLabel>
        {props.description && <FieldDescription>{props.description}</FieldDescription>}
      </FieldContent>
      <Switch id={id} checked={props.checked} onCheckedChange={(v) => props.onChange(v)} />
    </Field>
  );
}

/** Select over a fixed option list; shows the option's label, not its value. */
function SimpleSelect<T extends string>(props: {
  id?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Select value={props.value} items={props.options} onValueChange={(v) => v !== null && props.onChange(v as T)}>
      <SelectTrigger id={props.id} className={cn("w-full", props.className)} aria-label={props.ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Secret(props: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; onGenerate?: () => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={props.id}
        className={cn("font-mono", props.onGenerate ? "pr-14" : "pr-8")}
        type={shown ? "text" : "password"}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2">
        {props.onGenerate && (
          <IconAction label="重新生成" onClick={props.onGenerate}>
            <RefreshCw />
          </IconAction>
        )}
        <IconAction label={shown ? "隐藏" : "显示"} onClick={() => setShown(!shown)}>
          {shown ? <EyeOff /> : <Eye />}
        </IconAction>
      </div>
    </div>
  );
}

function IssueList(props: { issues: Issue[] }) {
  if (!props.issues.length) return null;
  const hasError = props.issues.some((i) => i.level === "error");
  return (
    <ul
      className={cn(
        "flex flex-col gap-1 rounded-md px-3 py-2 text-xs/relaxed",
        hasError ? "bg-destructive/[0.07]" : "bg-amber-500/[0.08]",
      )}
    >
      {props.issues.map((i, k) => (
        <li key={k} className={cn("flex items-start gap-2", i.level === "error" ? "text-destructive" : "text-amber-800 dark:text-amber-300")}>
          {i.level === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />}
          {i.detail}
        </li>
      ))}
    </ul>
  );
}

function IssueBadge(props: { issues: Issue[] }) {
  const errors = props.issues.filter((i) => i.level === "error").length;
  const warnings = props.issues.length - errors;
  if (errors) return <Badge variant="destructive">{errors} 个错误</Badge>;
  if (warnings) return <Badge className="bg-amber-500/15 text-amber-800 dark:text-amber-300">{warnings} 条提醒</Badge>;
  return null;
}

/** Collapsible card used for nodes, groups and tailnets. */
function ItemCard(props: {
  id: string;
  expanded: boolean;
  onToggle: () => void;
  title: ReactNode;
  meta: ReactNode;
  badges?: ReactNode;
  /** Errors and warnings: shown at every width, unlike `badges`. */
  issues?: Issue[];
  actions: ReactNode;
  /** Drag handle shown before the title, with the row ref and state from useDragSort. */
  handle?: ReactNode;
  rowRef?: (el: HTMLElement | null) => void;
  dragging?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      id={`item-${props.id}`}
      ref={props.rowRef}
      className={cn(
        "rounded-lg bg-card text-card-foreground ring-1 ring-foreground/10 transition-shadow",
        props.dragging && "relative z-10 shadow-lg ring-ring/50",
      )}
    >
      <div className={cn("flex items-center gap-1 pr-2", props.handle && "pl-1")}>
        {props.handle}
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
            props.handle ? "pl-1" : "pl-3",
          )}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", props.expanded && "rotate-90")} aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium">{props.title}</span>
            <span className="truncate text-xs text-muted-foreground">{props.meta}</span>
          </span>
          {props.badges && <span className="hidden shrink-0 items-center gap-1 sm:flex">{props.badges}</span>}
          {props.issues && <IssueBadge issues={props.issues} />}
        </button>
        <div className="flex shrink-0 items-center">{props.actions}</div>
      </div>
      {props.expanded && <div className="flex flex-col gap-4 border-t px-4 py-4">{props.children}</div>}
    </article>
  );
}

function IconAction(props: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={props.danger ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive" : "text-muted-foreground"}
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label={props.label}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

function NodeCard(props: {
  node: ProxyNode;
  issues: Issue[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (n: ProxyNode) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  sort: ReturnType<typeof useDragSort>;
}) {
  const { node: n } = props;
  const set = (patch: Partial<ProxyNode>) => props.onChange({ ...n, ...patch });
  const { object, endpoint } = nodeObject(n);
  const server = object && typeof object.server === "string" ? `${object.server}${object.server_port ? `:${object.server_port}` : ""}` : "";
  return (
    <ItemCard
      id={n.id}
      expanded={props.expanded}
      onToggle={props.onToggle}
      issues={props.issues}
      handle={<DragHandle label={n.tag || "未命名节点"} {...props.sort.handleProps(n.id)} />}
      rowRef={props.sort.rowRef(n.id)}
      dragging={props.sort.dragging === n.id}
      title={n.tag || "未命名节点"}
      meta={
        <span className="font-mono">
          {object ? String(object.type) : "未识别"}
          {server && ` · ${server}`}
        </span>
      }
      badges={
        <>
          {endpoint && <Badge variant="secondary">端点</Badge>}
          {!n.inGroups && <Badge variant="outline">不在代理组</Badge>}
        </>
      }
      actions={
        <>
          <IconAction label="复制节点" onClick={props.onDuplicate}>
            <CopyPlus />
          </IconAction>
          <IconAction label={`删除节点 ${n.tag}`} danger onClick={props.onRemove}>
            <Trash2 />
          </IconAction>
        </>
      }
    >
      <IssueList issues={props.issues} />
      <FormField label="标签" hint="出站标签，也是在客户端里看到的节点名">
        {(id) => <Input id={id} className="font-mono" value={n.tag} spellCheck={false} onChange={(e) => set({ tag: e.target.value.trim() })} />}
      </FormField>
      <FormField hintAbove label="节点配置" hint="sing-box 出站 JSON，可写注释；tag 由生成器填写">
        {(id) => <CodeEditor labelledBy={`${id}-label`} value={n.body} onChange={(body) => set({ body })} />}
      </FormField>
      <ToggleRow
        checked={n.inGroups}
        onChange={(inGroups) => set({ inGroups })}
        title="加入代理组"
        description="出现在 proxy 选择器和 auto 自动测速中；只作为其他节点 detour 的可以关掉"
      />
    </ItemCard>
  );
}

const TEMPLATE_OPTIONS = TEMPLATES.map((t) => ({ value: t.id, label: t.label }));

/** Templates in the picker, most used first. */
const TEMPLATE_GROUPS: { label: string; ids: string[] }[] = [
  { label: "常用", ids: ["hysteria2", "vless-reality", "vless-vision", "trojan", "shadowsocks", "tuic", "anytls", "vmess-ws"] },
  { label: "其他协议", ids: ["shadowtls", "hysteria", "naive", "snell", "socks", "http", "ssh", "tor"] },
  { label: "VPN（端点）", ids: ["wireguard", "openconnect", "openvpn-client"] },
];

function AddNode(props: { usedTags: string[]; onAdd: (n: ProxyNode) => void }) {
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const listed = new Set(TEMPLATE_GROUPS.flatMap((g) => g.ids));
  const groups = [...TEMPLATE_GROUPS, { label: "更多", ids: TEMPLATES.map((t) => t.id).filter((id) => !listed.has(id)) }].filter((g) => g.ids.length);
  return (
    <div className="flex items-center gap-1.5">
      <Select value={templateId} items={TEMPLATE_OPTIONS} onValueChange={(v) => v && setTemplateId(v as string)}>
        <SelectTrigger className="w-48" aria-label="协议模板">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectGroup key={g.label}>
              <SelectLabel>{g.label}</SelectLabel>
              {g.ids.map((id) => (
                <SelectItem key={id} value={id}>
                  {TEMPLATES.find((t) => t.id === id)?.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <Button
        onClick={() => {
          const t = TEMPLATES.find((x) => x.id === templateId)!;
          props.onAdd(newNode({ tag: freshTag(t.tagPrefix, props.usedTags), body: t.body }));
        }}
      >
        <Plus />
        添加节点
      </Button>
    </div>
  );
}

const PLATFORMS: { value: Platform; label: string; note: string }[] = [
  { value: "apple", label: "macOS / iOS（SFM、SFI）", note: "" },
  { value: "android", label: "Android（SFA）", note: "Android 上能否识别本机公网 IPv6 尚未实测；识别不了时，直连会只用 IPv4，不影响使用。" },
  { value: "linux", label: "Linux（命令行）", note: "启用 auto_redirect（基于 nftables，sing-box 推荐在 Linux 上开启）。" },
  { value: "windows", label: "Windows（命令行）", note: "" },
];

const MODES: { value: Settings["defaultMode"]; label: string; description: string }[] = [
  { value: "GFWList", label: "GFWList", description: "只有 gfwlist 里的网站走代理，其余直连。走代理的最少。" },
  { value: "Non-CN", label: "Non-CN", description: "国内的网站和 IP 直连，其余都走代理。" },
  { value: "Global", label: "Global", description: "除局域网外全部走代理，自定义的直连名单也不生效。" },
  { value: "Direct", label: "Direct", description: "全部直连，相当于暂时关掉代理。" },
];

/** Radio options as cards with a line of explanation each. */
function ChoiceCards<T extends string>(props: {
  value: T;
  options: { value: T; label: string; description: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  const pick = (i: number) => props.onChange(props.options[(i + props.options.length) % props.options.length].value);
  return (
    <div role="radiogroup" aria-label={props.ariaLabel} className="grid gap-2 sm:grid-cols-2">
      {props.options.map((o, i) => {
        const checked = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => props.onChange(o.value)}
            onKeyDown={(e) => {
              const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
              if (!step) return;
              e.preventDefault();
              pick(i + step);
              const next = e.currentTarget.parentElement?.children[(i + step + props.options.length) % props.options.length];
              (next as HTMLElement | undefined)?.focus();
            }}
            className={cn(
              "flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30",
              checked ? "border-primary bg-primary/[0.04]" : "hover:bg-muted/50",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                checked ? "border-primary" : "border-input",
              )}
              aria-hidden
            >
              {checked && <span className="size-1.5 rounded-full bg-primary" />}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-xs font-medium">{o.label}</span>
              <span className="text-xs/relaxed text-muted-foreground">{o.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Line-based list editor with live parse feedback. */
function ListEditor(props: {
  id?: string;
  lines: string[];
  onChange: (lines: string[]) => void;
  placeholder: string;
  summary: (text: string) => { count: number; invalid: string[] };
  unit: string;
}) {
  const { count, invalid } = props.summary(props.lines.join("\n"));
  return (
    <>
      <Textarea
        id={props.id}
        className="field-sizing-fixed font-mono text-base md:text-xs/relaxed"
        rows={Math.min(12, Math.max(3, props.lines.length + 1))}
        value={props.lines.join("\n")}
        placeholder={props.placeholder}
        spellCheck={false}
        onChange={(e) => props.onChange(e.target.value.split("\n"))}
      />
      {(count > 0 || invalid.length > 0) && (
        <p className="text-xs text-muted-foreground">
          {count > 0 && `已识别 ${count} ${props.unit}`}
          {invalid.length > 0 && <span className="text-destructive">{count > 0 && "；"}无法识别：{invalid.join("、")}</span>}
        </p>
      )}
    </>
  );
}

const domainSummary = (text: string) => {
  const { domains, invalid } = parseDomainList(text);
  return { count: domains.length, invalid };
};
const ruleSummary = (text: string) => {
  const { domains, cidrs, invalid } = parseRuleList(text);
  return { count: domains.length + cidrs.length, invalid };
};

interface Candidate {
  id: string;
  tag: string;
  kind: "节点" | "tailnet" | "代理组";
  detail: string;
}

/** Grip button for useDragSort: drag it, or focus it and press ↑/↓. */
function DragHandle({ label, className, ...props }: { label: string } & HTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-7 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 active:cursor-grabbing",
        className,
      )}
      aria-label={`拖动以调整 ${label} 的顺序，或按上下方向键`}
      title="拖动排序"
      {...props}
    >
      <GripVertical className="size-3.5" aria-hidden />
    </button>
  );
}

/**
 * Group members in one list: chosen members on top in their order (drag the handle, or focus it
 * and press ↑/↓; untick to remove), the rest below (tick to append). Search filters both;
 * "select matches" ticks all visible.
 */
function MemberPicker(props: { id?: string; candidates: Candidate[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = (c: Candidate) => !q || `${c.tag} ${c.detail}`.toLowerCase().includes(q);
  const selectedSet = new Set(props.selected);
  const chosen = props.selected.flatMap((id) => {
    const c = props.candidates.find((x) => x.id === id);
    return c && visible(c) ? [c] : [];
  });
  const rest = props.candidates.filter((c) => !selectedSet.has(c.id) && visible(c));
  const matches = props.candidates.filter(visible);
  const allMatched = matches.length > 0 && matches.every((c) => selectedSet.has(c.id));
  const add = (ids: string[]) => props.onChange([...props.selected, ...ids.filter((id) => !selectedSet.has(id))]);
  const remove = (ids: string[]) => props.onChange(props.selected.filter((id) => !ids.includes(id)));

  // Reordering acts on the visible chosen rows; hidden members keep their places in the full list.
  const visibleIds = chosen.map((c) => c.id);
  const sort = useDragSort(visibleIds, (next) => {
    const shown = new Set(visibleIds);
    let k = 0;
    props.onChange(props.selected.map((id) => (shown.has(id) ? next[k++] : id)));
  });

  const row = (c: Candidate, checked: boolean) => (
    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-1.5 pr-2">
      <Checkbox
        checked={checked}
        onCheckedChange={() => (checked ? remove : add)([c.id])}
        aria-label={`${checked ? "移出" : "加入"} ${c.tag}`}
      />
      <span className="min-w-0 truncate">
        <span className="font-mono">{c.tag}</span>
        <span className="text-muted-foreground">
          {" "}
          · {c.kind}
          {c.detail && ` · ${c.detail}`}
        </span>
      </span>
    </label>
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            id={props.id}
            type="search"
            className="pl-7"
            value={query}
            placeholder="按名称、协议或服务器筛选，例如 us、hysteria2"
            aria-label="筛选成员"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button variant="outline" disabled={!matches.length} onClick={() => (allMatched ? remove : add)(matches.map((c) => c.id))}>
          {allMatched ? `取消选择这 ${matches.length} 项` : `选中${q ? "匹配的" : "全部"} ${matches.length} 项`}
        </Button>
      </div>
      <ul className="max-h-80 overflow-y-auto rounded-md border p-1 text-xs" aria-label="成员">
        {chosen.map((c) => (
          <li
            key={c.id}
            ref={sort.rowRef(c.id)}
            className={cn("flex items-center rounded-md", sort.dragging === c.id ? "relative z-10 bg-accent shadow-md ring-1 ring-ring/40" : "hover:bg-muted/60")}
          >
            <DragHandle label={c.tag} {...sort.handleProps(c.id)} />
            {row(c, true)}
          </li>
        ))}
        {chosen.length > 0 && rest.length > 0 && <li className="mx-2 my-1 border-t" role="separator" />}
        {rest.map((c) => (
          <li key={c.id} className="flex items-center rounded-md pl-6 hover:bg-muted/60">
            {row(c, false)}
          </li>
        ))}
        {!chosen.length && !rest.length && <li className="px-2 py-1.5 text-muted-foreground">没有匹配的项</li>}
      </ul>
    </div>
  );
}

const GROUP_TYPES: { value: ProxyGroup["type"]; label: string }[] = [
  { value: "selector", label: "手动选择" },
  { value: "urltest", label: "自动测速" },
];

function GroupCard(props: {
  group: ProxyGroup;
  candidates: Candidate[];
  issues: Issue[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (g: ProxyGroup) => void;
  onRemove: () => void;
}) {
  const { group: g, candidates } = props;
  const set = (patch: Partial<ProxyGroup>) => props.onChange({ ...g, ...patch });
  const memberTags = g.members.map((id) => candidates.find((c) => c.id === id)?.tag).filter(Boolean) as string[];
  const defaultOptions = [
    { value: "", label: "第一个成员" },
    ...g.members.flatMap((id) => {
      const c = candidates.find((x) => x.id === id);
      return c ? [{ value: id, label: c.tag }] : [];
    }),
  ];
  return (
    <ItemCard
      id={g.id}
      expanded={props.expanded}
      onToggle={props.onToggle}
      issues={props.issues}
      title={g.tag || "未命名代理组"}
      meta={
        <>
          {g.type === "urltest" ? "自动测速" : "手动选择"} · {memberTags.length} 个成员
          {memberTags.length > 0 && (
            <span className="font-mono">
              ：{memberTags.slice(0, 4).join("、")}
              {memberTags.length > 4 ? "…" : ""}
            </span>
          )}
        </>
      }
      actions={
        <IconAction label={`删除代理组 ${g.tag}`} danger onClick={props.onRemove}>
          <Trash2 />
        </IconAction>
      }
    >
      <IssueList issues={props.issues} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="名称" hint="在客户端的节点列表里显示的组名">
          {(id) => <Input id={id} className="font-mono" value={g.tag} spellCheck={false} onChange={(e) => set({ tag: e.target.value.trim() })} />}
        </FormField>
        <Field>
          <FieldLabel>类型</FieldLabel>
          <ToggleGroup
            variant="outline"
            spacing={0}
            value={[g.type]}
            onValueChange={(v) => v[0] && set({ type: v[0] as ProxyGroup["type"] })}
            aria-label="代理组类型"
          >
            {GROUP_TYPES.map((t) => (
              <ToggleGroupItem key={t.value} value={t.value} className="px-3 aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/90">
                {t.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>{g.type === "urltest" ? "定时测速，自动使用延迟最低的成员" : "在客户端里手动选用哪个成员"}</FieldDescription>
        </Field>
      </div>
      <FormField
        hintAbove
        label={`成员（已选 ${g.members.length} 项）`}
        hint={`已选的排在上面，拖动左侧手柄调整顺序；客户端按此顺序显示${g.type === "selector" ? "，没设默认选中时用第一个" : ""}`}
      >
        {(id) => <MemberPicker id={id} candidates={candidates.filter((c) => c.id !== g.id)} selected={g.members} onChange={(members) => set({ members })} />}
      </FormField>
      {g.type === "selector" ? (
        <FormField label="默认选中" hint="客户端第一次启动时选中的成员">
          {(id) => <SimpleSelect id={id} value={g.defaultMember} options={defaultOptions} onChange={(defaultMember) => set({ defaultMember })} className="sm:w-1/2" />}
        </FormField>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="测速间隔" hint="留空为 3m">
            {(id) => <Input id={id} value={g.interval} placeholder="3m" spellCheck={false} onChange={(e) => set({ interval: e.target.value.trim() })} />}
          </FormField>
          <FormField label="容差（毫秒）" hint="延迟差在此范围内不切换，留空为 50">
            {(id) => (
              <Input
                id={id}
                value={g.tolerance ?? ""}
                placeholder="50"
                inputMode="numeric"
                onChange={(e) => set({ tolerance: e.target.value.trim() === "" ? null : Number(e.target.value) })}
              />
            )}
          </FormField>
          <FormField label="测速地址" hint="留空为 https://www.gstatic.com/generate_204" wide>
            {(id) => (
              <Input
                id={id}
                value={g.testUrl}
                placeholder="https://www.gstatic.com/generate_204"
                spellCheck={false}
                onChange={(e) => set({ testUrl: e.target.value.trim() })}
              />
            )}
          </FormField>
        </div>
      )}
    </ItemCard>
  );
}

/** What an import will add, for the confirmation dialog. */
function ImportSummary(props: { rows: { label: string; tags: string[] }[]; notes: string[] }) {
  const SHOWN = 12;
  return (
    <div className="flex flex-col gap-3 text-xs">
      <dl className="flex flex-col gap-2">
        {props.rows.map((r) => (
          <div key={r.label} className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted-foreground">
              {r.label} <span className="font-medium text-foreground tabular-nums">{r.tags.length}</span>
            </dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {r.tags.length === 0 && <span className="text-muted-foreground">无</span>}
              {r.tags.slice(0, SHOWN).map((t) => (
                <Badge key={t} variant="secondary" className="font-mono">
                  {t}
                </Badge>
              ))}
              {r.tags.length > SHOWN && <span className="text-muted-foreground">等 {r.tags.length} 个</span>}
            </dd>
          </div>
        ))}
      </dl>
      {props.notes.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md bg-muted/60 px-3 py-2 text-muted-foreground">
          {props.notes.map((n) => (
            <li key={n} className="flex gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Divides a long card into parts. */
function SubHeading(props: { children: ReactNode }) {
  return <h3 className="-mb-1 border-t pt-4 text-xs font-medium text-muted-foreground">{props.children}</h3>;
}

/** What a tab is about, as its own paragraph above everything else. */
function Intro(props: { children: ReactNode }) {
  return <p className="max-w-prose text-xs/relaxed text-muted-foreground">{props.children}</p>;
}

/** Title and count of a list, with its actions on the right. */
function ListHead(props: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      <h2 className="text-xs font-medium">
        {props.title}
        <span className="ml-1.5 text-muted-foreground tabular-nums">{props.count}</span>
      </h2>
      <div className="flex flex-wrap items-center gap-1.5">{props.children}</div>
    </div>
  );
}

function Empty(props: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">{props.children}</p>;
}

/** A plain settings panel. */
function Panel(props: { title?: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
      {(props.title || props.description) && (
        <header className="flex flex-col gap-0.5">
          {props.title && <h2 className="text-sm font-medium">{props.title}</h2>}
          {props.description && <p className="text-xs/relaxed text-muted-foreground">{props.description}</p>}
        </header>
      )}
      {props.children}
    </section>
  );
}

function RoutingCard(props: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const { settings: s } = props;
  return (
    <>
      <Panel title="默认模式" description="启动时使用的模式，运行中可在客户端或 Clash API 中切换">
        <ChoiceCards value={s.defaultMode} options={MODES} onChange={(defaultMode) => props.onChange({ defaultMode })} ariaLabel="默认模式" />
      </Panel>
      <Panel
        title="自定义列表"
        description={
          <>
            每行一项，域名同时匹配所有子域名；<span className="font-mono">#</span> 之后为注释。
          </>
        }
      >
        <FormField hintAbove label="直连域名" hint="除 Global 外始终直连，用本地 DNS 解析">
          {(id) => (
            <ListEditor
              id={id}
              lines={s.directDomains}
              onChange={(directDomains) => props.onChange({ directDomains })}
              placeholder={"example.cn\nintranet.example.com  # 公司内网"}
              summary={domainSummary}
              unit="个域名"
            />
          )}
        </FormField>
        <FormField hintAbove label="代理域名和 IP" hint="除 Direct 外始终走代理；适合被墙但不在 gfwlist 里的网站">
          {(id) => (
            <ListEditor
              id={id}
              lines={s.proxyRules}
              onChange={(proxyRules) => props.onChange({ proxyRules })}
              placeholder={"intercom.io\n203.0.113.0/24"}
              summary={ruleSummary}
              unit="项"
            />
          )}
        </FormField>
      </Panel>
    </>
  );
}

function TailnetCard(props: {
  tailnet: Tailnet;
  issues: Issue[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (t: Tailnet) => void;
  onRemove: () => void;
}) {
  const { tailnet: t } = props;
  const set = (patch: Partial<Tailnet>) => props.onChange({ ...t, ...patch });
  const { endpoint } = tailnetEndpoint(t);
  const host = endpoint && typeof endpoint.hostname === "string" ? endpoint.hostname : "";
  return (
    <ItemCard
      id={t.id}
      expanded={props.expanded}
      onToggle={props.onToggle}
      issues={props.issues}
      title={t.tag || "未命名 tailnet"}
      meta={
        <span className="font-mono">
          tailscale{host && ` · ${host}`}
          {(t.magicDns || t.dnsDomains.some((l) => l.trim())) && ` · dns: ${t.tag}-dns`}
        </span>
      }
      badges={
        <>
          {t.asProxy && <Badge variant="secondary">代理出口</Badge>}
        </>
      }
      actions={
        <IconAction label={`删除 tailnet ${t.tag}`} danger onClick={props.onRemove}>
          <Trash2 />
        </IconAction>
      }
    >
      <IssueList issues={props.issues} />
      <FormField label="标签" hint="端点的标签；DNS 服务器会命名为「标签-dns」">
        {(id) => <Input id={id} className="font-mono" value={t.tag} spellCheck={false} onChange={(e) => set({ tag: e.target.value.trim() })} />}
      </FormField>
      <FormField hintAbove label="端点配置" hint="sing-box tailscale 端点 JSON，可写注释；type 和 tag 由生成器填写">
        {(id) => <CodeEditor labelledBy={`${id}-label`} value={t.endpoint} onChange={(endpoint) => set({ endpoint })} maxLines={16} />}
      </FormField>
      <SubHeading>DNS</SubHeading>
      <ToggleRow
        checked={t.magicDns}
        onChange={(magicDns) => set({ magicDns })}
        title="MagicDNS"
        description="tailnet 设备名和 tailnet 下发的 DNS 路由后缀交给它解析"
      />
      <ToggleRow
        checked={t.acceptDefaultResolvers}
        onChange={(acceptDefaultResolvers) => set({ acceptDefaultResolvers })}
        title="使用 tailnet 的默认 DNS 服务器"
        description="交给它的域名不在 MagicDNS 里时，用 tailnet 配置的全局 DNS 解析"
      />
      <FormField hintAbove label="分域 DNS" hint="交给这个 tailnet 解析的域名，例如公司内网域名，才能拿到内网地址">
        {(id) => (
          <ListEditor
            id={id}
            lines={t.dnsDomains}
            onChange={(dnsDomains) => set({ dnsDomains })}
            placeholder="corp.example.com"
            summary={domainSummary}
            unit="个域名"
          />
        )}
      </FormField>
      <SubHeading>路由</SubHeading>
      <FormField hintAbove label="额外路由" hint="走这个 tailnet 的域名或 IP 段；tailnet 设备和已批准的子网路由会自动识别，不用填。指向 tailnet 之外的地址时，需要作为代理出口并填出口节点">
        {(id) => (
          <ListEditor
            id={id}
            lines={t.routes}
            onChange={(routes) => set({ routes })}
            placeholder={"10.20.0.0/16\nnas.example.com"}
            summary={ruleSummary}
            unit="项"
          />
        )}
      </FormField>
      <ToggleRow
        checked={t.asProxy}
        onChange={(asProxy) => set({ asProxy })}
        title="作为代理出口"
        description="加入 proxy 选择器，可手动选用；经它的流量从出口节点出去"
      />
      {(t.asProxy || t.exitNode) && (
        <FormField label="出口节点" hint="tailnet 里开启了出口节点的设备名或 Tailscale IP，写入端点的 exit_node">
          {(id) => <Input id={id} className="font-mono sm:w-1/2" value={t.exitNode} placeholder="home-gw" spellCheck={false} onChange={(e) => set({ exitNode: e.target.value.trim() })} />}
        </FormField>
      )}
    </ItemCard>
  );
}

const DNS_OPTIONS: { value: RemoteDnsChoice; label: string }[] = [
  ...Object.entries(REMOTE_DNS).map(([value, p]) => ({ value: value as RemoteDnsChoice, label: `${p.label}（${p.address}）` })),
  { value: "custom", label: "自定义…" },
];
const DNS_PROTOCOLS: { value: RemoteDnsProtocol; label: string }[] = [
  { value: "tls", label: "DNS over TLS" },
  { value: "https", label: "DNS over HTTPS" },
];

function SettingsCard(props: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const { settings: s } = props;
  const set = props.onChange;
  const platform = PLATFORMS.find((p) => p.value === s.platform);
  return (
    <>
      <Panel title="平台">
        <FormField label="目标平台" hint={platform?.note || undefined}>
          {(id) => (
            <SimpleSelect id={id} value={s.platform} options={PLATFORMS} onChange={(platform) => set({ platform })} className="sm:w-1/2" />
          )}
        </FormField>
      </Panel>
      <Panel title="代理 DNS" description="走代理的域名经代理用它解析；直连的域名始终用本地 DNS。">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="服务器">
            {(id) => (
              <SimpleSelect
                id={id}
                value={s.remoteDns.provider}
                options={DNS_OPTIONS}
                onChange={(provider) => set({ remoteDns: { ...s.remoteDns, provider } })}
              />
            )}
          </FormField>
          {s.remoteDns.provider !== "custom" ? (
            <FormField label="协议">
              {(id) => (
                <SimpleSelect
                  id={id}
                  value={s.remoteDns.protocol}
                  options={DNS_PROTOCOLS}
                  onChange={(protocol) => set({ remoteDns: { ...s.remoteDns, protocol } })}
                />
              )}
            </FormField>
          ) : (
            <FormField hintAbove label="自定义 DNS 服务器" hint="sing-box DNS 服务器 JSON，可写注释；tag 由生成器填写，默认经 proxy 访问" wide>
              {(id) => (
                <CodeEditor
                  labelledBy={`${id}-label`}
                  value={s.remoteDns.custom}
                  onChange={(custom) => set({ remoteDns: { ...s.remoteDns, custom } })}
                  minLines={6}
                  maxLines={14}
                />
              )}
            </FormField>
          )}
          <FormField label="ECS 网段" hint="随查询发给代理 DNS 的 EDNS Client Subnet。留空时按代理服务器位置返回结果，通常更合适" wide>
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                value={s.clientSubnet}
                placeholder="留空（推荐）"
                spellCheck={false}
                onChange={(e) => set({ clientSubnet: e.target.value.trim() })}
              />
            )}
          </FormField>
        </div>
      </Panel>
      <Panel title="Clash API" description="供面板或脚本查看连接、切换节点和模式。">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="监听地址" hint="留空则不开启">
            {(id) => (
              <Input
                id={id}
                className="font-mono"
                value={s.clashController}
                placeholder="127.0.0.1:9090"
                spellCheck={false}
                onChange={(e) => set({ clashController: e.target.value.trim() })}
              />
            )}
          </FormField>
          <FormField label="访问密码（secret）" hint="面板连接时填写；留空则任何网页都能控制它">
            {(id) => <Secret id={id} value={s.clashSecret} onChange={(clashSecret) => set({ clashSecret })} onGenerate={() => set({ clashSecret: randomSecret() })} />}
          </FormField>
        </div>
      </Panel>
      <Panel title="可选规则">
        <ToggleRow
          checked={s.steam}
          onChange={(steam) => set({ steam })}
          title="Steam"
          description="局域网缓存 lancache 用本地 DNS 解析；Non-CN 模式下 Steam 下载直连"
        />
        <ToggleRow
          checked={s.blockIcloudQuic}
          onChange={(blockIcloudQuic) => set({ blockIcloudQuic })}
          title="禁止 iCloud 使用 QUIC"
          description="拒绝到 gateway.icloud.com 的 UDP 443，让它改用 TCP"
        />
      </Panel>
    </>
  );
}

/** The profile with `id` removed from every group's members. */
function dropMember(p: Profile, id: string | undefined): Profile {
  if (!id) return p;
  return {
    ...p,
    groups: p.groups.map((g) => ({
      ...g,
      members: g.members.filter((m) => m !== id),
      defaultMember: g.defaultMember === id ? "" : g.defaultMember,
    })),
  };
}

/** A node whose server is still the template's example address. */
function isExampleNode(n: ProxyNode): boolean {
  const { object } = nodeObject(n);
  const server = object && typeof object.server === "string" ? object.server : "";
  return /(^|\.)example\.com$/.test(server);
}

function uniqueName(name: string, store: Store): string {
  const names = store.profiles.map((p) => p.name);
  if (!names.includes(name)) return name;
  for (let i = 2; ; i++) if (!names.includes(`${name} ${i}`)) return `${name} ${i}`;
}

type Tab = "nodes" | "groups" | "routing" | "tailscale" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "nodes", label: "节点" },
  { id: "groups", label: "代理组" },
  { id: "routing", label: "分流" },
  { id: "tailscale", label: "Tailscale" },
  { id: "settings", label: "设置" },
];
const TAB_KEY = "singbox-gen:tab";

function loadTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (TABS.some((x) => x.id === t)) return t as Tab;
  } catch {
    // Storage blocked: start on the first tab.
  }
  return "nodes";
}

/**
 * The generated config, a row per line, with `ranges` shaded. The first range is scrolled into
 * view when `scrollKey` changes or the sheet opens; with `reveal`, only when it is out of view, so
 * typing doesn't move the preview around.
 */
function ConfigPreview(props: {
  lines: ReactNode[][];
  ranges: LineRange[];
  scrollKey: string | null;
  reveal: boolean;
  wrap: boolean;
  /** False while its sheet is closed; opening it jumps to the first range again. */
  visible?: boolean;
  /** A line to scroll to on demand (the change list); `seq` makes repeats work. */
  jump?: { line: number; seq: number } | null;
}) {
  const ref = useRef<HTMLPreElement>(null);
  /** The key last scrolled for; undefined while hidden, so reopening jumps again (without animation). */
  const scrolledTo = useRef<string | null | undefined>(undefined);
  const first = props.ranges[0]?.start;
  useEffect(() => {
    if (props.visible === false) {
      scrolledTo.current = undefined;
      return;
    }
    if (first === undefined || scrolledTo.current === props.scrollKey) return;
    const smooth = scrolledTo.current !== undefined;
    scrolledTo.current = props.scrollKey;
    // In a sheet that is just opening, layout isn't done yet: wait a frame.
    const frame = requestAnimationFrame(() => {
      const pre = ref.current;
      // A deletion at the very end sits before a line that doesn't exist: aim at the last one.
      const row = pre?.querySelector(`[data-line="${Math.min(first, props.lines.length - 1)}"]`) as HTMLElement | null;
      if (!pre || !row) return;
      const offset = row.getBoundingClientRect().top - pre.getBoundingClientRect().top;
      if (props.reveal && offset >= 0 && offset + row.offsetHeight <= pre.clientHeight) return;
      pre.scrollTo({ top: Math.max(0, offset + pre.scrollTop - 48), behavior: smooth ? "smooth" : "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.scrollKey, props.visible, first === undefined]);
  useEffect(() => {
    const pre = ref.current;
    const jump = props.jump;
    if (!pre || !jump || props.visible === false) return;
    const row = pre.querySelector(`[data-line="${Math.min(jump.line, props.lines.length - 1)}"]`) as HTMLElement | null;
    if (!row) return;
    const offset = row.getBoundingClientRect().top - pre.getBoundingClientRect().top;
    pre.scrollTo({ top: Math.max(0, offset + pre.scrollTop - 48), behavior: "smooth" });
  }, [props.jump?.seq]);
  const shaded = (i: number) => props.ranges.some((r) => !r.deleted && i >= r.start && i <= r.end);
  /** A deletion shows as a red line where the lines were, before row `i`. */
  const deletedBefore = (i: number) => props.ranges.some((r) => r.deleted && r.start === i);
  const deletedLine = <div aria-hidden className="relative z-10 -my-px h-0.5 bg-destructive" />;
  return (
    <pre
      ref={ref}
      className={cn("code relative min-h-0 flex-1 overflow-auto px-0", props.wrap && "whitespace-pre-wrap [overflow-wrap:anywhere]")}
      tabIndex={0}
      aria-label="生成的 config.json"
    >
      <div className={props.wrap ? undefined : "w-max min-w-full"}>
        {props.lines.map((line, i) => (
          <Fragment key={i}>
            {deletedBefore(i) && deletedLine}
            <div data-line={i} className={cn("px-3.5", shaded(i) && "bg-primary/[0.07] shadow-[inset_2px_0_0_var(--color-primary)]")}>
              {line.length ? line : "\n"}
            </div>
          </Fragment>
        ))}
        {deletedBefore(props.lines.length) && deletedLine}
      </div>
    </pre>
  );
}

/** First and last line of the object whose "tag" is `tag` in pretty-printed JSON. */
function jsonBlock(text: string, tag: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim().replace(/,$/, "") === `"tag": ${JSON.stringify(tag)}`);
  if (at < 0) return null;
  const indent = lines[at].length - lines[at].trimStart().length - 2;
  let start = at;
  while (start > 0 && !(lines[start].trim() === "{" && lines[start].length - lines[start].trimStart().length === indent)) start--;
  let end = at;
  while (end < lines.length - 1 && !(/^\},?$/.test(lines[end].trim()) && lines[end].length - lines[end].trimStart().length === indent)) end++;
  return { start, end };
}

/** JSON with keys, strings, numbers and literals wrapped for colouring. */
function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const cls = m[1] ? (m[2] ? "tok-key" : "tok-str") : m[3] ? "tok-lit" : "tok-num";
    out.push(
      <span key={m.index} className={cls}>
        {m[1] ?? m[0]}
      </span>,
    );
    if (m[2]) out.push(m[2]);
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return out;
}

export default function App() {
  const [store, setStore] = useState<Store>(loadStore);
  const [dialogs, dialogView] = useDialogs();
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const notify = (text: string, undo?: () => void) => setToast({ text, undo });
  const [tab, setTabState] = useState<Tab>(loadTab);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showIssues, setShowIssues] = useState(false);
  const [preview, setPreview] = useState(false);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  /** The node, group or tailnet last opened or edited; the preview follows it. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = store.profiles.find((p) => p.id === store.activeId) ?? store.profiles[0];
  const profile = active.profile;
  const setProfile = (update: (p: Profile) => Profile) =>
    setStore((s) => ({
      ...s,
      profiles: s.profiles.map((x) => (x.id === s.activeId ? { ...x, profile: update(x.profile) } : x)),
    }));
  const setTab = (t: Tab) => {
    // What the preview shades belongs to the tab being left.
    if (t !== tab) {
      setFocusId(null);
      setEdit(null);
    }
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // Ignore: only a convenience.
    }
  };
  const toggle = (id: string) => {
    if (!expanded.has(id)) {
      setFocusId(id);
      setEdit(null);
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => saveStore(store), [store]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 6000 : 2000);
    return () => clearTimeout(t);
  }, [toast]);
  // After navigating to a card, bring it into view and flash it.
  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(`item-${scrollTo}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
    }
    setScrollTo(null);
  }, [scrollTo, tab, expanded]);

  const issues = useMemo(() => validate(profile), [profile]);
  const configText = useMemo(() => JSON.stringify(generateConfig(profile), null, 2), [profile]);
  const configLines = useMemo(() => configText.split("\n"), [configText]);
  const previewLines = useMemo(() => configLines.map(highlightJson), [configLines]);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const issuesFor = (id: string) => issues.filter((i) => i.id === id);
  const sectionIssues = (section: Tab) => issues.filter((i) => i.section === section && !i.id);
  const tabState = (section: Tab) => {
    const list = issues.filter((i) => i.section === section);
    return list.some((i) => i.level === "error") ? "error" : list.length ? "warning" : "";
  };

  const goTo = (i: Issue) => {
    setTab(i.section);
    if (i.id) {
      setExpanded((prev) => new Set(prev).add(i.id!));
      setScrollTo(i.id);
    }
  };

  const setSettings = (patch: Partial<Settings>) => setProfile((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  const updateNode = (i: number, n: ProxyNode) => setProfile((p) => ({ ...p, nodes: p.nodes.map((x, j) => (j === i ? n : x)) }));
  // Deleting is immediate; the toast offers undo for as long as nothing else has changed.
  const profileNow = useRef(profile);
  profileNow.current = profile;
  const removeWithUndo = (what: string, update: (p: Profile) => Profile) => {
    const before = profile;
    const after = update(before);
    setProfile(() => after);
    notify(`已删除${what}`, () => {
      if (profileNow.current === after) setProfile(() => before);
      else notify("删除后又有修改，无法撤销");
    });
  };
  const removeNode = (i: number) => {
    const n = profile.nodes[i];
    removeWithUndo(`节点「${n.tag || "未命名"}」`, (p) => ({ ...dropMember(p, n.id), nodes: p.nodes.filter((x) => x.id !== n.id) }));
  };
  const duplicateNode = (i: number) => {
    const n = profile.nodes[i];
    const used = [...profile.nodes.map((x) => x.tag), ...profile.groups.map((x) => x.tag), ...tailnets.map((x) => x.tag)];
    const copy = newNode({ tag: freshTag(n.tag.replace(/-\d+$/, "") || "node", used), body: n.body, inGroups: n.inGroups });
    setProfile((p) => ({
      ...p,
      nodes: [...p.nodes.slice(0, i + 1), copy, ...p.nodes.slice(i + 1)],
      // The copy joins the same groups, right after the original.
      groups: p.groups.map((g) => (g.members.includes(n.id) ? { ...g, members: g.members.flatMap((m) => (m === n.id ? [m, copy.id] : [m])) } : g)),
    }));
    setExpanded((prev) => new Set(prev).add(copy.id));
    setFocusId(copy.id);
    setScrollTo(copy.id);
  };
  const removeTailnet = (i: number) => {
    const t = profile.settings.tailnets[i];
    removeWithUndo(` tailnet「${t.tag || "未命名"}」`, (p) => {
      const q = dropMember(p, t.id);
      return { ...q, settings: { ...q.settings, tailnets: q.settings.tailnets.filter((x) => x.id !== t.id) } };
    });
  };
  const addGroup = () => {
    const g = newGroup({ tag: freshTag("group", [...profile.groups.map((x) => x.tag), ...profile.nodes.map((n) => n.tag)]) });
    setProfile((p) => ({ ...p, groups: [...p.groups, g] }));
    setExpanded((prev) => new Set(prev).add(g.id));
    setScrollTo(g.id);
  };
  const removeGroup = (i: number) => {
    const g = profile.groups[i];
    removeWithUndo(`代理组「${g.tag || "未命名"}」`, (p) => {
      const q = dropMember(p, g.id);
      return {
        ...q,
        groups: q.groups.filter((x) => x.id !== g.id),
        settings: { ...q.settings, proxyDefault: q.settings.proxyDefault === g.id ? "auto" : q.settings.proxyDefault },
      };
    });
  };
  const candidates: Candidate[] = [
    ...profile.nodes.map((n) => {
      const { object } = nodeObject(n);
      const server = object && typeof object.server === "string" ? object.server : "";
      return { id: n.id, tag: n.tag, kind: "节点" as const, detail: [object ? String(object.type) : "", server].filter(Boolean).join(" · ") };
    }),
    ...profile.settings.tailnets.map((t) => ({ id: t.id, tag: t.tag, kind: "tailnet" as const, detail: "" })),
    ...profile.groups.map((g) => ({ id: g.id, tag: g.tag, kind: "代理组" as const, detail: g.type === "urltest" ? "自动测速" : "手动选择" })),
  ];
  // Client lists, proxy and auto follow the node order.
  const nodeSort = useDragSort(
    profile.nodes.map((n) => n.id),
    (ids) => setProfile((p) => ({ ...p, nodes: ids.map((id) => p.nodes.find((n) => n.id === id)!) })),
  );
  const addNode = (n: ProxyNode) => {
    setProfile((p) => ({ ...p, nodes: [...p.nodes, n] }));
    setExpanded((prev) => new Set(prev).add(n.id));
    setScrollTo(n.id);
  };
  const addTailnet = () => {
    const tailnets = profile.settings.tailnets;
    const t = newTailnet({ tag: tailnets.length ? `ts${tailnets.length + 1}` : "ts" });
    setSettings({ tailnets: [...tailnets, t] });
    setExpanded((prev) => new Set(prev).add(t.id));
    setScrollTo(t.id);
  };

  const addProfile = (name: string, p?: Profile) => {
    const saved = newSavedProfile(name, p);
    setStore((s) => ({ activeId: saved.id, profiles: [...s.profiles, saved] }));
  };

  const importConfig = async (file: File) => {
    let result: ImportResult;
    try {
      result = importSingBoxConfig(await file.text());
    } catch (e) {
      await dialogs.alert("导入失败", (e as Error).message);
      return;
    }
    // Untouched template examples (still pointing at example.com) are replaced rather than kept.
    const keep = profile.nodes.every(isExampleNode) ? [] : profile.nodes;
    const { nodes, tailnets, groups, renamed } = fitImport(result, [
      ...keep.map((n) => n.tag),
      ...profile.settings.tailnets.map((t) => t.tag),
      ...profile.groups.map((g) => g.tag),
    ]);
    const content = (
      <ImportSummary
        rows={[
          { label: "节点", tags: nodes.map((n) => n.tag) },
          { label: "tailnet", tags: tailnets.map((t) => t.tag) },
          { label: "代理组", tags: groups.map((g) => g.tag) },
        ]}
        notes={[
          ...(keep.length < profile.nodes.length ? ["现有的示例节点会被替换"] : []),
          ...(renamed.length ? [`标签重复，已改名：${renamed.join("、")}`] : []),
          ...result.notes,
        ]}
      />
    );
    const ok = await dialogs.confirm(`导入到「${active.name}」`, {
      message: `来自 ${file.name}。只导入节点、Tailscale 和代理组；DNS 和分流由本工具的策略生成。`,
      content,
      confirmLabel: "导入",
    });
    if (!ok) return;
    setProfile((p) => ({
      ...p,
      nodes: [...keep, ...nodes],
      groups: [...p.groups, ...groups],
      settings: { ...p.settings, tailnets: [...p.settings.tailnets, ...tailnets] },
    }));
    setTab(nodes.length ? "nodes" : "tailscale");
    notify(`已导入 ${nodes.length} 个节点、${tailnets.length} 个 tailnet${groups.length ? `、${groups.length} 个代理组` : ""}`);
  };

  const tailnets = profile.settings.tailnets;
  const counts: Partial<Record<Tab, number>> = { nodes: profile.nodes.length, groups: profile.groups.length, tailscale: tailnets.length };
  // Still the template's examples: the config can't be used yet, whatever else checks out.
  const examplesLeft = profile.nodes.length > 0 && profile.nodes.every(isExampleNode);
  const statusTone = errors.length ? "error" : warnings.length || examplesLeft ? "warning" : "ok";
  const statusText = errors.length
    ? `${errors.length} 个错误`
    : examplesLeft
      ? "节点还是示例"
      : warnings.length
        ? `${warnings.length} 条提醒`
        : "可以使用";
  const StatusIcon = errors.length ? CircleAlert : warnings.length || examplesLeft ? TriangleAlert : CircleCheck;
  const focusTag = [...profile.nodes, ...profile.groups, ...tailnets].find((x) => x.id === focusId)?.tag;
  const focusLines = useMemo(() => (focusTag ? jsonBlock(configText, focusTag) : null), [configText, focusTag]);
  // What the last edit changed in the config; shown until a card is opened. A switch may touch
  // several places (MagicDNS: DNS server and rules), which the focused item's block wouldn't show.
  const [edit, setEdit] = useState<{ ranges: LineRange[]; seq: number } | null>(null);
  const prevConfig = useRef({ text: configText, profileId: active.id });
  useEffect(() => {
    const prev = prevConfig.current;
    prevConfig.current = { text: configText, profileId: active.id };
    if (prev.profileId !== active.id) setEdit(null);
    else if (prev.text !== configText) setEdit((e) => ({ ranges: changedLines(prev.text, configText), seq: (e?.seq ?? 0) + 1 }));
  }, [configText, active.id]);
  const [jump, setJump] = useState<{ line: number; seq: number; at: number; edit: number } | null>(null);
  const previewProps = {
    ...(edit
      ? { ranges: edit.ranges, scrollKey: `edit-${edit.seq}`, reveal: true }
      : { ranges: focusLines ? [focusLines] : [], scrollKey: focusId, reveal: false }),
    jump,
  };
  // The changes of the last edit, each named by where it sits, so scattered ones can be visited.
  const paths = useMemo(() => linePaths(configLines), [configLines]);
  const changes = useMemo(
    () =>
      (edit?.ranges ?? []).map((r) => {
        const body = (l: string) => l.trim().replace(/,$/, "");
        const text = r.deleted ? "" : (configLines.slice(r.start, r.end + 1).map(body).find((l) => !/^[{}[\]]$/.test(l)) ?? body(configLines[r.start]));
        return { line: r.start, path: paths[Math.min(r.start, paths.length - 1)] || "根", deleted: !!r.deleted, text };
      }),
    [edit, configLines, paths],
  );
  const goToChange = (i: number) => {
    const c = changes[(i + changes.length) % changes.length];
    setJump({ line: c.line, seq: (jump?.seq ?? 0) + 1, at: (i + changes.length) % changes.length, edit: edit?.seq ?? 0 });
  };
  const changeAt = jump && jump.edit === edit?.seq ? jump.at : -1;
  const changeNav = changes.length > 0 && (
    <span className="flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="h-6 gap-0.5 px-1.5 font-normal text-muted-foreground" />}>
          {changes.length} 处改动
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-80 overflow-y-auto">
          {changes.map((c, i) => (
            <DropdownMenuItem key={i} className="flex-col items-start gap-0" onClick={() => goToChange(i)}>
              <span className="font-mono text-[11px] text-muted-foreground">
                {c.path}
                {c.deleted && " · 删除"}
              </span>
              {c.text && <span className="w-full truncate font-mono">{c.text}</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {changes.length > 1 && (
        <>
          <IconAction label="上一处改动" onClick={() => goToChange((changeAt < 0 ? 0 : changeAt) - 1)}>
            <ChevronUp />
          </IconAction>
          <IconAction label="下一处改动" onClick={() => goToChange(changeAt + 1)}>
            <ChevronDown />
          </IconAction>
        </>
      )}
    </span>
  );
  const wrapToggle = (
    <IconAction label={wrap ? "不自动换行" : "自动换行"} onClick={() => setWrap(!wrap)}>
      <WrapText className={wrap ? "text-foreground" : undefined} />
    </IconAction>
  );
  const configStats = `${configText.split("\n").length} 行 · ${(new Blob([configText]).size / 1024).toFixed(1)} KB`;
  /** Errors mean sing-box will likely refuse the file: say so before it leaves the page. */
  const confirmExport = async (verb: string) =>
    !errors.length ||
    (await dialogs.confirm(`配置里还有 ${errors.length} 个错误，仍然${verb}？`, {
      message: `sing-box 可能无法加载这份配置：\n${errors.map((i) => `· ${i.message}`).join("\n")}`,
      confirmLabel: `仍然${verb}`,
    }));
  const copyConfig = async () => {
    if (!(await confirmExport("复制"))) return;
    notify((await copyText(configText)) ? "已复制到剪贴板" : "复制失败，请手动选择");
  };
  const downloadConfig = async () => {
    if (await confirmExport("下载")) download("config.json", configText);
  };

  const manageMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="管理配置" />}>
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>配置「{active.name}」</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={async () => {
              const name = await dialogs.askText("新建配置", uniqueName("新配置", store), {
                message: "从示例开始，例如按设备命名：Mac、iPhone。",
                confirmLabel: "新建",
              });
              if (name) addProfile(uniqueName(name, store));
            }}
          >
            <Plus />
            新建配置
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={async () => {
              const name = await dialogs.askText("复制当前配置", uniqueName(`${active.name} 副本`, store), { confirmLabel: "复制" });
              if (name) addProfile(uniqueName(name, store), structuredClone(profile));
            }}
          >
            <CopyPlus />
            复制当前配置
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={async () => {
              const name = await dialogs.askText("重命名配置", active.name, { confirmLabel: "重命名" });
              if (name && name !== active.name) {
                const unique = uniqueName(name, store);
                setStore((s) => ({ ...s, profiles: s.profiles.map((p) => (p.id === active.id ? { ...p, name: unique } : p)) }));
              }
            }}
          >
            <Pencil />
            重命名…
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => fileInput.current?.click()}>
          <FileUp />从 sing-box 配置导入节点…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={store.profiles.length < 2}
          onClick={async () => {
            if (!(await dialogs.confirm(`删除配置「${active.name}」？`, { confirmLabel: "删除", danger: true }))) return;
            const profiles = store.profiles.filter((p) => p.id !== active.id);
            setStore({ activeId: profiles[0].id, profiles });
          }}
        >
          <Trash2 />
          删除当前配置
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            const ok = await dialogs.confirm("清除全部本地数据？", {
              message: `这个浏览器里保存的 ${store.profiles.length} 套配置都会被删除，并恢复为示例。此操作无法撤销。`,
              confirmLabel: "全部清除",
              danger: true,
            });
            if (!ok) return;
            clearStore();
            setStore(defaultStore());
          }}
        >
          <RotateCcw />
          清除全部本地数据
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground lg:h-svh">
      <header className="sticky top-0 z-30 shrink-0 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex max-w-3xl flex-wrap lg:max-w-[1400px] items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto sm:flex-1">
            <Boxes className="size-5 shrink-0 text-primary" aria-hidden />
            <h1 className="mr-auto truncate text-sm font-semibold">
              sing-box <span className="hidden min-[400px]:inline">配置</span>生成器
            </h1>
            <Select
              value={active.id}
              items={store.profiles.map((p) => ({ value: p.id, label: p.name }))}
              onValueChange={(v) => v && setStore((s) => ({ ...s, activeId: v as string }))}
            >
              <SelectTrigger className="w-32 sm:w-40" aria-label="当前配置">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {store.profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {manageMenu}
          </div>
          <Separator orientation="vertical" className="hidden h-6 sm:block" />
          <div className="flex w-full items-center gap-1.5 sm:w-auto">
            <Button variant="ghost" size="sm" className={`mr-auto status-pill ${statusTone}`} onClick={() => setShowIssues(true)} aria-label={`检查结果：${statusText}`}>
              <StatusIcon />
              {statusText}
            </Button>
            <Button variant="outline" size="sm" className="lg:hidden" onClick={() => setPreview(true)}>
              <Eye />
              预览
            </Button>
            <Button variant="outline" size="sm" onClick={copyConfig}>
              <Copy />
              复制
            </Button>
            <Button size="sm" onClick={downloadConfig}>
              <Download />
              下载
            </Button>
          </div>
        </div>
      </header>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importConfig(f);
          e.target.value = "";
        }}
      />

      {/* Settings on the left; on wide screens the page itself doesn't scroll: the settings column
          scrolls on its own (so its scrollbar sits next to it, not beyond the preview) and the
          generated config fills the right column. */}
      <main className="mx-auto grid w-full max-w-3xl items-start gap-6 px-4 pt-1 lg:min-h-0 lg:flex-1 lg:max-w-[1400px] lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-stretch">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-w-0 gap-4 lg:min-h-0">
          <div className="-mx-4 overflow-x-auto border-b px-4 [scrollbar-width:none] lg:mx-0 lg:px-0">
            <TabsList variant="line" className="h-10" aria-label="设置分类">
              {TABS.map((t) => {
                const state = tabState(t.id);
                return (
                  <TabsTrigger key={t.id} value={t.id} className="px-2 text-[13px] sm:px-2.5">
                    {t.label}
                    {counts[t.id] !== undefined && (
                      <span className="hidden rounded-full bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground tabular-nums min-[420px]:inline">{counts[t.id]}</span>
                    )}
                    {state && <span className={`dot ${state}`} aria-label={state === "error" ? "有错误" : "有提醒"} />}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          {/* A scroll container clips what is drawn outside its children: the 1px rings around cards and
              panels, and focus rings. The negative margin plus padding leaves room for them. */}
          <section className="flex min-w-0 flex-col gap-3 pb-16 lg:-mx-1 lg:-mt-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-1 lg:pt-1 lg:pr-3 lg:pb-8" aria-label={TABS.find((t) => t.id === tab)?.label}>
            {sectionIssues(tab).length > 0 && <IssueList issues={sectionIssues(tab)} />}

            {tab === "nodes" && (
              <>
                <Intro>每个节点是一段 sing-box 出站配置，可以按协议模板新加，也可以从现有的 sing-box 配置导入。拖动左侧手柄调整顺序，客户端里按此顺序显示。</Intro>
                <ListHead title="节点" count={profile.nodes.length}>
                  <Button variant="ghost" onClick={() => fileInput.current?.click()}>
                    <FileUp />
                    导入
                  </Button>
                  <AddNode usedTags={profile.nodes.map((n) => n.tag)} onAdd={addNode} />
                </ListHead>
                {profile.nodes.length === 0 && <Empty>还没有节点：选择协议模板，点击「添加节点」。</Empty>}
                {profile.nodes.map((n, i) => (
                  <NodeCard
                    key={n.id}
                    node={n}
                    issues={issuesFor(n.id)}
                    expanded={expanded.has(n.id)}
                    onToggle={() => toggle(n.id)}
                    onChange={(next) => {
                      setFocusId(n.id);
                      updateNode(i, next);
                    }}
                    onRemove={() => removeNode(i)}
                    onDuplicate={() => duplicateNode(i)}
                    sort={nodeSort}
                  />
                ))}
              </>
            )}

            {tab === "groups" && (
              <>
                <Intro>
                  所有走代理的流量都经过 <span className="font-mono">proxy</span>：可以选 <span className="font-mono">auto</span>
                  （全部节点自动测速）、下面的代理组，或单个节点。节点多时可以按地区、用途分组。
                </Intro>
                <Panel title="proxy 选择器">
                  <FormField label="默认选择" hint="客户端第一次启动时使用">
                    {(id) => (
                      <SimpleSelect
                        id={id}
                        value={profile.settings.proxyDefault}
                        options={[{ value: "auto", label: "auto（全部节点自动测速）" }, ...profile.groups.map((g) => ({ value: g.id, label: g.tag }))]}
                        onChange={(proxyDefault) => setSettings({ proxyDefault })}
                        className="sm:w-1/2"
                      />
                    )}
                  </FormField>
                  <ToggleRow
                    checked={profile.settings.listNodesInProxy}
                    onChange={(listNodesInProxy) => setSettings({ listNodesInProxy })}
                    title="逐个列出节点"
                    description="节点多时可以关掉，客户端里只显示 auto 和各代理组"
                  />
                </Panel>
                <ListHead title="代理组" count={profile.groups.length}>
                  <Button onClick={addGroup}>
                    <Plus />
                    添加代理组
                  </Button>
                </ListHead>
                {profile.groups.length === 0 && <Empty>还没有代理组。节点不多时不需要，直接用 auto 或手动选节点即可。</Empty>}
                {profile.groups.map((g, i) => (
                  <GroupCard
                    key={g.id}
                    group={g}
                    candidates={candidates}
                    issues={issuesFor(g.id)}
                    expanded={expanded.has(g.id)}
                    onToggle={() => toggle(g.id)}
                    onChange={(next) => {
                      setFocusId(g.id);
                      setProfile((p) => ({ ...p, groups: p.groups.map((x) => (x.id === g.id ? next : x)) }));
                    }}
                    onRemove={() => removeGroup(i)}
                  />
                ))}
              </>
            )}

            {tab === "routing" && <RoutingCard settings={profile.settings} onChange={setSettings} />}

            {tab === "tailscale" && (
              <>
                <Intro>需要访问 tailnet 里的设备或公司内网时添加。tailnet 设备和已批准的子网路由会自动走对应的 tailnet。</Intro>
                <ListHead title="tailnet" count={tailnets.length}>
                  <Button onClick={addTailnet}>
                    <Plus />
                    添加 tailnet
                  </Button>
                </ListHead>
                {tailnets.length === 0 && <Empty>还没有 tailnet。需要从这台设备访问家里或公司 tailnet 里的设备、子网时再添加。</Empty>}
                {tailnets.map((t, i) => (
                  <TailnetCard
                    key={t.id}
                    tailnet={t}
                    issues={issuesFor(t.id)}
                    expanded={expanded.has(t.id)}
                    onToggle={() => toggle(t.id)}
                    onChange={(next) => {
                      setFocusId(t.id);
                      setSettings({ tailnets: tailnets.map((x, j) => (j === i ? next : x)) });
                    }}
                    onRemove={() => removeTailnet(i)}
                  />
                ))}
              </>
            )}

            {tab === "settings" && <SettingsCard settings={profile.settings} onChange={setSettings} />}
            <p className="mt-6 text-center text-xs text-muted-foreground">
              纯前端运行，配置只保存在这个浏览器里，不会上传。生成的配置适用于 sing-box 1.14 及以上。
            </p>
          </section>
        </Tabs>

        <aside className="hidden min-w-0 flex-col overflow-hidden rounded-lg ring-1 ring-foreground/10 lg:my-3 lg:flex lg:min-h-0" aria-label="生成的配置">
          <div className="flex items-center justify-between gap-3 border-b bg-card py-1 pr-1 pl-3">
            <span className="font-mono text-xs font-medium">config.json</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {configStats}
              {changeNav}
              {wrapToggle}
            </span>
          </div>
          <ConfigPreview lines={previewLines} {...previewProps} wrap={wrap} />
        </aside>
      </main>

      <Sheet open={showIssues} onOpenChange={setShowIssues}>
        <SheetContent side="right" className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          <SheetHeader>
            <SheetTitle>检查结果</SheetTitle>
            <SheetDescription>
              {errors.length
                ? "有错误时 sing-box 可能无法加载这份配置。点击条目跳到对应位置。"
                : examplesLeft
                  ? "节点还是模板里的示例，需要换成你自己的服务器，或从现有的 sing-box 配置导入。"
                  : warnings.length
                  ? "可以生成，但建议看一下这些提醒。点击条目跳到对应位置。"
                  : "没有发现问题，可以导入客户端。"}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
            {/* Tabs with errors first. */}
            {[...TABS].sort((a, b) => Number(tabState(b.id) === "error") - Number(tabState(a.id) === "error")).map((t) => {
              const list = [...errors, ...warnings].filter((i) => i.section === t.id);
              if (!list.length) return null;
              return (
                <section key={t.id} className="flex flex-col gap-1">
                  <h3 className="px-2 text-xs font-medium text-muted-foreground">
                    {t.label} · {list.length}
                  </h3>
                  <ul className="flex flex-col">
                    {list.map((i, k) => (
                      <li key={k}>
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs/relaxed hover:bg-muted"
                          onClick={() => {
                            setShowIssues(false);
                            goTo(i);
                          }}
                        >
                          {i.level === "error" ? (
                            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                          ) : (
                            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                          )}
                          <span className="flex-1">{i.message}</span>
                          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={preview} onOpenChange={setPreview}>
        <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
          <SheetHeader className="border-b">
            <SheetTitle className="font-mono">config.json</SheetTitle>
            <SheetDescription>{configStats}</SheetDescription>
            <div className="flex items-center gap-1.5 pt-1">
              <Button variant="outline" size="sm" onClick={copyConfig}>
                <Copy />
                复制
              </Button>
              <Button size="sm" onClick={downloadConfig}>
                <Download />
                下载
              </Button>
              <span className="ml-auto flex items-center">
                {changeNav}
                {wrapToggle}
              </span>
            </div>
          </SheetHeader>
          <ConfigPreview lines={previewLines} {...previewProps} wrap={wrap} visible={preview} />
        </SheetContent>
      </Sheet>

      {dialogView}
      {toast && (
        <div className="toast flex items-center gap-3" role="status">
          {toast.text}
          {toast.undo && (
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() => {
                toast.undo!();
                setToast(null);
              }}
            >
              撤销
            </button>
          )}
        </div>
      )}
    </div>
  );
}
