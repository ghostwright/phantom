import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/ui/button";

export function CodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [code]);

  return (
    <div className="group relative my-2 overflow-hidden rounded-lg border border-border">
      {language && (
        <div className="flex items-center justify-between border-b border-border bg-muted px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">
            {language}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100"
            onClick={handleCopy}
            aria-label="Copy code"
          >
            {copied ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </Button>
        </div>
      )}
      <pre className="overflow-x-auto p-3">
        <code className="font-mono text-sm text-foreground">{code}</code>
      </pre>
      {!language && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 h-6 w-6 opacity-0 group-hover:opacity-100"
          onClick={handleCopy}
          aria-label="Copy code"
        >
          {copied ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      )}
    </div>
  );
}
