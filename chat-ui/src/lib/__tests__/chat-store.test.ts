import { describe, expect, it } from "vitest";
import { createChatStore, dispatchFrame } from "../chat-store";

function send(
  store: ReturnType<typeof createChatStore>,
  event: string,
  data: Record<string, unknown>,
): void {
  dispatchFrame(store, event, JSON.stringify(data));
}

describe("chat-store reducer: text block lifecycle", () => {
  it("accumulates text_delta into a single content block for one text_start", () => {
    const store = createChatStore();
    send(store, "message.assistant_start", { message_id: "a1" });
    send(store, "message.text_start", {
      message_id: "a1",
      text_block_id: "tb_0_0",
      index: 0,
    });
    send(store, "message.text_delta", {
      text_block_id: "tb_0_0",
      delta: "Hello",
    });
    send(store, "message.text_delta", {
      text_block_id: "tb_0_0",
      delta: " world",
    });
    send(store, "message.text_end", { text_block_id: "tb_0_0" });
    send(store, "message.assistant_end", {
      message_id: "a1",
      interrupted: false,
    });

    const state = store.getState();
    const last = state.messages[state.messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content.length).toBe(1);
    expect(last?.content[0]?.type).toBe("text");
    expect(last?.content[0]?.text).toBe("Hello world");
    expect(last?.content[0]?.blockId).toBe("tb_0_0");
  });

  it("text_reconcile replaces accumulated delta text instead of appending", () => {
    const store = createChatStore();
    send(store, "message.assistant_start", { message_id: "a1" });
    send(store, "message.text_start", {
      message_id: "a1",
      text_block_id: "tb_0_0",
      index: 0,
    });
    send(store, "message.text_delta", {
      text_block_id: "tb_0_0",
      delta: "Hello world",
    });
    send(store, "message.text_end", { text_block_id: "tb_0_0" });
    send(store, "message.assistant_end", {
      message_id: "a1",
      interrupted: false,
    });
    send(store, "message.text_reconcile", {
      text_block_id: "tb_0_0",
      full_text: "Hello world",
    });

    const state = store.getState();
    const last = state.messages[state.messages.length - 1];
    expect(last?.content.length).toBe(1);
    expect(last?.content[0]?.text).toBe("Hello world");
  });

  it("text_reconcile with divergent canonical text snaps the block to the final value", () => {
    const store = createChatStore();
    send(store, "message.assistant_start", { message_id: "a1" });
    send(store, "message.text_start", {
      message_id: "a1",
      text_block_id: "tb_0_0",
      index: 0,
    });
    send(store, "message.text_delta", {
      text_block_id: "tb_0_0",
      delta: "Hello wrold",
    });
    send(store, "message.text_end", { text_block_id: "tb_0_0" });
    send(store, "message.text_reconcile", {
      text_block_id: "tb_0_0",
      full_text: "Hello world",
    });

    const state = store.getState();
    const last = state.messages[state.messages.length - 1];
    expect(last?.content.length).toBe(1);
    expect(last?.content[0]?.text).toBe("Hello world");
  });

  it("text_reconcile for a block that was never started is a no-op", () => {
    const store = createChatStore();
    send(store, "message.assistant_start", { message_id: "a1" });
    send(store, "message.text_reconcile", {
      text_block_id: "tb_0_0",
      full_text: "Hello world",
    });

    const state = store.getState();
    const last = state.messages[state.messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content.length).toBe(0);
  });
});
