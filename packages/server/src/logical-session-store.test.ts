import { describe, expect, test } from "bun:test";
import { LogicalSessionStore } from "./logical-session-store";

describe("LogicalSessionStore", () => {
  test("previous response resolves only after a completed response is committed", () => {
    const clock = fakeClock();
    const store = new LogicalSessionStore({ now: clock.now, ttlMs: 3_600_000, maxEntries: 10_240 });
    const first = store.begin({ hints: { candidates: [], transcript: ["hello"] }, headers: new Headers() });
    expect(
      store.begin({
        hints: { candidates: [], previousResponseId: "resp_1", transcript: ["next"] },
        headers: new Headers(),
      }).session.source,
    ).toBe("generated");
    store.commitResponse("resp_1", first.session.key);
    expect(
      store.begin({
        hints: { candidates: [], previousResponseId: "resp_1", transcript: ["next"] },
        headers: new Headers(),
      }).session,
    ).toEqual({ key: first.session.key, source: "previous-response" });
  });

  test("uses internal, protocol, header, then generated priority", () => {
    const store = new LogicalSessionStore();
    const protocol = [{ source: "body-session", value: "body" }] as const;
    const input = {
      hints: { candidates: protocol, transcript: ["hello"] },
      headers: new Headers({ "x-session-id": "header" }),
    };

    expect(store.begin({ ...input, internalSessionId: "internal" }).session.source).toBe("internal");
    expect(store.begin(input).session.source).toBe("body-session");
    expect(store.begin({ ...input, hints: { candidates: [], transcript: ["hello"] } }).session.source).toBe(
      "header-session",
    );
    expect(
      store.begin({ hints: { candidates: [], transcript: ["hello"] }, headers: new Headers() }).session.source,
    ).toBe("generated");
    expect(
      store.begin({ hints: { candidates: [], transcript: undefined }, headers: new Headers() }).session.source,
    ).toBe("generated");
  });

  test("generates independent sessions for identical headerless transcripts", () => {
    const store = new LogicalSessionStore();
    const input = {
      hints: { candidates: [], transcript: [{ role: "user", content: "hello" }] },
      headers: new Headers(),
    };
    const first = store.begin(input);
    const second = store.begin(input);

    expect(second.session.key).not.toBe(first.session.key);
    expect(first.session.source).toBe("generated");
    expect(second.session.source).toBe("generated");
  });

  test("keeps explicit session candidates stable across appended transcripts", () => {
    const store = new LogicalSessionStore();
    const candidates = [{ source: "body-session", value: "session_1" }] as const;
    const first = store.begin({
      hints: { candidates, transcript: [{ role: "user", content: "hello" }] },
      headers: new Headers(),
    });
    const next = store.begin({
      hints: {
        candidates,
        transcript: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "next" },
        ],
      },
      headers: new Headers(),
    });

    expect(next.session).toEqual(first.session);
    expect(first.session.source).toBe("body-session");
  });

  test("refreshes previous-response expiry on reads and deletes expired mappings", () => {
    const clock = fakeClock();
    const store = new LogicalSessionStore({ now: clock.now, ttlMs: 100, maxEntries: 10 });
    const first = store.begin({ hints: { candidates: [], transcript: ["first"] }, headers: new Headers() });
    store.commitResponse("resp_1", first.session.key);

    clock.advance(90);
    expect(previous(store, "resp_1").session.source).toBe("previous-response");
    clock.advance(90);
    expect(previous(store, "resp_1").session.source).toBe("previous-response");
    clock.advance(101);
    expect(previous(store, "resp_1").session.source).toBe("generated");
  });

  test("evicts the least recently accessed response mapping over capacity", () => {
    const clock = fakeClock();
    const store = new LogicalSessionStore({ now: clock.now, ttlMs: 1_000, maxEntries: 2 });
    const first = session(store, "first");
    const second = session(store, "second");
    store.commitResponse("resp_1", first);
    clock.advance(1);
    store.commitResponse("resp_2", second);
    clock.advance(1);
    expect(previous(store, "resp_1").session.source).toBe("previous-response");
    clock.advance(1);
    store.commitResponse("resp_3", session(store, "third"));

    expect(previous(store, "resp_1").session.source).toBe("previous-response");
    expect(previous(store, "resp_2").session.source).toBe("generated");
    expect(previous(store, "resp_3").session.source).toBe("previous-response");
  });
});

function session(store: LogicalSessionStore, value: string) {
  return store.begin({ hints: { candidates: [], transcript: [value] }, headers: new Headers() }).session.key;
}

function previous(store: LogicalSessionStore, responseId: string) {
  return store.begin({
    hints: { candidates: [], previousResponseId: responseId, transcript: ["fallback"] },
    headers: new Headers(),
  });
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}
