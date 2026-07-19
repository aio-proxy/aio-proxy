import { contentBlockStop, event, thinkingStart } from "./format";

type ThinkingBlock = {
  readonly id: string;
  index: number | undefined;
  pendingText: string;
  signature: string | undefined;
};

export type AnthropicThinkingStream = {
  readonly close: () => void;
  readonly delta: (id: string, text: string, signature: string | undefined) => void;
  readonly end: (id: string, signature: string | undefined) => void;
  readonly start: (id: string, signature: string | undefined) => void;
};

export function createAnthropicThinkingStream(input: {
  readonly enqueue: (chunk: Uint8Array) => void;
  readonly nextIndex: () => number;
}): AnthropicThinkingStream {
  const blocks = new Map<string, ThinkingBlock>();
  let active: ThinkingBlock | undefined;

  const open = (block: ThinkingBlock): number | undefined => {
    if (block.signature === undefined) return undefined;
    if (block.index !== undefined) return block.index;
    block.index = input.nextIndex();
    input.enqueue(thinkingStart(block.index));
    if (block.pendingText !== "") {
      input.enqueue(thinkingDelta(block.index, block.pendingText));
      block.pendingText = "";
    }
    return block.index;
  };

  const close = (block: ThinkingBlock | undefined): void => {
    if (block === undefined) return;
    const index = open(block);
    blocks.delete(block.id);
    if (active?.id === block.id) active = undefined;
    if (index === undefined) return;
    input.enqueue(
      event({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature ?? "" },
      }),
    );
    input.enqueue(contentBlockStop(index));
  };

  return {
    start(id, signature) {
      if (active?.id !== id) close(active);
      active = blocks.get(id);
      if (active === undefined) {
        active = { id, index: undefined, pendingText: "", signature };
        blocks.set(id, active);
      } else {
        active.signature = signature ?? active.signature;
      }
      open(active);
    },
    delta(id, text, signature) {
      let block = blocks.get(id);
      if (block === undefined) {
        close(active);
        block = { id, index: undefined, pendingText: "", signature };
        blocks.set(id, block);
      }
      block.signature = signature ?? block.signature;
      active = block;
      if (block.index === undefined) {
        block.pendingText += text;
        open(block);
      } else {
        input.enqueue(thinkingDelta(block.index, text));
      }
    },
    end(id, signature) {
      const block = blocks.get(id);
      if (block !== undefined) block.signature = signature ?? block.signature;
      close(block);
    },
    close() {
      close(active);
    },
  };
}

function thinkingDelta(index: number, thinking: string): Uint8Array {
  return event({
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  });
}
