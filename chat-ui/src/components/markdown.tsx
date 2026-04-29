import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { CodeBlock } from "./code-block";

export function Markdown({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          code({ className, children, node: _node, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            if (!match) {
              return (
                <code
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <CodeBlock
                language={match[1]}
                code={String(children).replace(/\n$/, "")}
              />
            );
          },
          a({ href, children, node: _node, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
