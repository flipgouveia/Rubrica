// Mock event bus (CONTRACTS §5).
//
// There is no real Tauri backend emitting events in mock mode, so this
// module is a tiny in-process pub/sub that mimics the shape of the real
// `events.*` objects generated in `src/ipc/bindings.ts` (see `makeEvent`
// there): each event exposes `.listen(cb)` / `.once(cb)` / `.emit(payload)`,
// and is ALSO callable with a `Webview`/`Window` target (real tauri-specta
// events are windows/webview-scoped) — the mock ignores the target and
// always broadcasts to every listener, since there is only ever one "window"
// in a plain browser.
//
// Domain command modules (document.ts, annotations.ts, pages.ts, ...) never
// construct these directly — all emission happens centrally in
// `mock/state.ts`'s `commitMutation`/`undoDoc`/`redoDoc`/`saveDoc` helpers,
// so revision bookkeeping and event payloads can't drift apart.
//
// `EventCallback`/`UnlistenFn` are imported with `import type` purely for
// their shape (an object literal `{event, id, payload}` and `() => void`)
// — this is a type-only import, fully erased at compile time, so it does
// NOT pull any real Tauri runtime code into the mock bundle.
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import type { DocStateChanged, RecoveryAvailable, SaveStateChanged, SearchBatch } from "../bindings";

type MockEvent<T> = ((target?: unknown) => {
  listen: (cb: EventCallback<T>) => Promise<UnlistenFn>;
  once: (cb: EventCallback<T>) => Promise<UnlistenFn>;
  emit: (payload: T) => Promise<void>;
}) & {
  listen: (cb: EventCallback<T>) => Promise<UnlistenFn>;
  once: (cb: EventCallback<T>) => Promise<UnlistenFn>;
  emit: (payload: T) => Promise<void>;
};

function makeMockEvent<T>(name: string): MockEvent<T> {
  const listeners = new Set<EventCallback<T>>();
  let nextId = 1;

  const emit = (payload: T): Promise<void> => {
    const event = { event: name, id: nextId++, payload };
    // Snapshot before iterating: a `once` listener removes itself mid-loop.
    for (const cb of Array.from(listeners)) cb(event);
    return Promise.resolve();
  };

  const listen = (cb: EventCallback<T>): Promise<UnlistenFn> => {
    listeners.add(cb);
    return Promise.resolve(() => {
      listeners.delete(cb);
    });
  };

  const once = (cb: EventCallback<T>): Promise<UnlistenFn> => {
    const wrapped: EventCallback<T> = (event) => {
      listeners.delete(wrapped);
      cb(event);
    };
    listeners.add(wrapped);
    return Promise.resolve(() => {
      listeners.delete(wrapped);
    });
  };

  const base = { listen, once, emit };
  // The real event object is callable with a Webview/Window target for a
  // scoped listener; the mock broadcasts to everyone regardless, so the
  // target is accepted (for signature parity) and ignored.
  const fn = (target?: unknown) => {
    void target;
    return base;
  };
  return Object.assign(fn, base);
}

export const docStateChanged = makeMockEvent<DocStateChanged>("doc_state_changed");
export const recoveryAvailable = makeMockEvent<RecoveryAvailable>("recovery_available");
export const saveState = makeMockEvent<SaveStateChanged>("save_state");
export const searchBatch = makeMockEvent<SearchBatch>("search_batch");
