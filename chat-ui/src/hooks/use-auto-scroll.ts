import { useCallback, useEffect, useRef, useState } from "react";

export function useAutoScroll(): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  scrollToBottom: (instant?: boolean) => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userScrolledRef = useRef(false);

  const scrollToBottom = useCallback((instant?: boolean) => {
    const el = containerRef.current;
    if (!el) return;
    userScrolledRef.current = false;
    setIsAtBottom(true);
    el.scrollTo({
      top: el.scrollHeight,
      behavior: instant ? "instant" : "smooth",
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const threshold = 40;

    const handleScroll = (): void => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      setIsAtBottom(atBottom);
      if (!atBottom) {
        userScrolledRef.current = true;
      }
    };

    // Both observers share one rAF slot so we coalesce container resize
    // (mobile keyboard, sidebar toggle, rotation) and child mutations
    // (streaming tokens, tool cards) into at most one scroll per frame.
    // MutationObserver alone missed container-resize pins to bottom;
    // ResizeObserver alone missed mid-stream delta updates. Sharing
    // rafPending preserves the "two-reflows-per-tick" fix while
    // restoring the resize responsiveness that got dropped.
    let rafPending = false;
    const scheduleScroll = (): void => {
      if (userScrolledRef.current || rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
        rafPending = false;
      });
    };

    const mutationObserver = new MutationObserver(scheduleScroll);
    mutationObserver.observe(el, { childList: true, subtree: true });

    const resizeObserver = new ResizeObserver(scheduleScroll);
    resizeObserver.observe(el);

    el.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      el.removeEventListener("scroll", handleScroll);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, []);

  return { containerRef, isAtBottom, scrollToBottom };
}
