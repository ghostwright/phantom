import {
  AlertCircle,
  Check,
  ChevronDown,
  FileText,
  Loader2,
  Shield,
  Terminal,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { ToolCallState } from "@/lib/chat-types";

const TOOL_ICONS: Record<string, typeof Terminal> = {
  Read: FileText,
  Write: FileText,
  Edit: FileText,
  Bash: Terminal,
  Glob: FileText,
  Grep: FileText,
  WebSearch: FileText,
  WebFetch: FileText,
};

function getToolIcon(toolName: string) {
  return TOOL_ICONS[toolName] ?? Terminal;
}

function getToolSubtitle(tool: ToolCallState): string {
  try {
    const input = tool.input ?? JSON.parse(tool.inputJson || "{}");
    const data = input as Record<string, unknown>;

    switch (tool.toolName) {
      case "Read":
        return (data.file_path as string) ?? "";
      case "Write":
        return (data.file_path as string) ?? "";
      case "Edit":
        return (data.file_path as string) ?? "";
      case "Bash":
        return truncate((data.command as string) ?? "", 60);
      case "Glob":
        return (data.pattern as string) ?? "";
      case "Grep":
        return (data.pattern as string) ?? "";
      case "WebSearch":
        return (data.query as string) ?? "";
      case "WebFetch":
        return (data.url as string) ?? "";
      case "Agent":
        return (data.description as string) ?? (data.prompt as string) ?? "";
      default:
        return tool.toolName;
    }
  } catch {
    return tool.toolName;
  }
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

type StateStyle = {
  border: string;
  icon: typeof Terminal;
  iconClass: string;
  showSpinner?: boolean;
};

function getStateStyle(state: ToolCallState["state"]): StateStyle {
  switch (state) {
    case "pending":
      return { border: "border-muted", icon: Terminal, iconClass: "animate-pulse text-muted-foreground" };
    case "input_streaming":
      return { border: "border-primary/50 animate-pulse", icon: Terminal, iconClass: "text-primary" };
    case "input_complete":
      return { border: "border-border", icon: Terminal, iconClass: "text-foreground" };
    case "running":
      return { border: "border-success", icon: Loader2, iconClass: "text-success animate-spin", showSpinner: true };
    case "result":
      return { border: "border-border", icon: Check, iconClass: "text-success" };
    case "error":
      return { border: "border-error", icon: XCircle, iconClass: "text-error" };
    case "aborted":
      return { border: "border-muted", icon: AlertCircle, iconClass: "text-muted-foreground line-through" };
    case "blocked":
      return { border: "border-warning", icon: Shield, iconClass: "text-warning" };
  }
}

export function ToolCallCard({ tool }: { tool: ToolCallState }) {
  const style = getStateStyle(tool.state);
  const Icon = getToolIcon(tool.toolName);
  const StatusIcon = style.icon;
  const subtitle = getToolSubtitle(tool);

  const autoExpand =
    tool.state === "error" || tool.state === "blocked";
  const [isOpen, setIsOpen] = useState(autoExpand);

  useEffect(() => {
    if (tool.state === "error" || tool.state === "blocked") {
      setIsOpen(true);
    }
  }, [tool.state]);

  const hasBody =
    tool.output || tool.error || tool.blockReason || tool.inputJson;

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-lg border transition-colors",
        style.border,
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm"
        disabled={!hasBody}
      >
        <Icon className={cn("h-4 w-4 shrink-0", style.iconClass)} />
        <div className="min-w-0 flex-1 text-left">
          <span className="font-medium text-foreground">{tool.toolName}</span>
          {subtitle && (
            <span className="ml-2 truncate text-muted-foreground">
              {subtitle}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {tool.state === "running" && tool.elapsedSeconds != null && (
            <span className="font-mono text-xs text-muted-foreground">
              {tool.elapsedSeconds}s
            </span>
          )}
          {tool.state !== "pending" && tool.state !== "running" && (
            <StatusIcon className={cn("h-3.5 w-3.5", style.iconClass)} />
          )}
          {tool.state === "running" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-success" />
          )}
          {hasBody && (
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                isOpen && "rotate-180",
              )}
            />
          )}
        </div>
      </button>

      {isOpen && hasBody && (
        <div className="border-t border-border bg-muted/30 px-3 py-2">
          {tool.error && (
            <p className="text-sm text-error">{tool.error}</p>
          )}
          {tool.blockReason && (
            <p className="text-sm text-warning">{tool.blockReason}</p>
          )}
          {tool.output && (
            <pre className="max-h-40 overflow-auto font-mono text-xs text-foreground">
              {truncate(tool.output, 2000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
