type EventEmitter<T = void> = {
  on: (fn: (arg: T) => void) => () => void;
  emit: (arg?: T) => void;
};

function createEmitter<T = void>(): EventEmitter<T> {
  const subs = new Set<(arg: T) => void>();
  return {
    on(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    emit(arg?: T) {
      for (const fn of subs) fn(arg as T);
    },
  };
}

export class ContextManager {
  // Standalone stub — no Mattercraft runtime.
}

export class Component<T = Record<string, unknown>> {
  constructor(_cm: ContextManager, _props: T) {}

  protected getZComponentInstance(_scene: unknown): { nodes: Record<string, unknown> } {
    return { nodes: {} };
  }

  protected register(_emitter: unknown, _handler: unknown): void {}

  dispose(): never {
    throw new Error('Component.dispose not implemented in standalone stub');
  }
}

export { createEmitter };
