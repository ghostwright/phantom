import { useBootstrap } from "@/hooks/use-bootstrap";

export function EmptyState({
  onSuggestionClick,
}: {
  onSuggestionClick: (text: string) => void;
}) {
  const { data, cachedName, cachedGen } = useBootstrap();

  const defaultSuggestions = [
    "What can you do?",
    "Show me your current configuration",
    "What scheduled jobs do you have?",
    "Tell me about your recent activity",
  ];

  const suggestions = data?.suggestions?.length
    ? data.suggestions
    : defaultSuggestions;

  const agentName = data?.agent_name ?? cachedName ?? "Agent";
  const evolutionGen = data?.evolution_gen ?? cachedGen ?? 0;

  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="max-w-2xl text-center">
        <h1 className="font-serif text-4xl tracking-tight text-foreground sm:text-5xl">
          What can I help you with?
        </h1>
        <p className="mt-4 text-base text-muted-foreground">
          {agentName} is ready to help.
          {evolutionGen > 0 ? ` Generation ${evolutionGen}.` : ""}
        </p>
      </div>

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggestionClick(suggestion)}
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
