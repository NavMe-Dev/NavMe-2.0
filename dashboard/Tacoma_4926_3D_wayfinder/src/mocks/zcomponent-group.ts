import { ContextManager } from './zcomponent-core';

type Observable<T> = { value: T };

function obs<T>(v: T): Observable<T> {
  return { value: v };
}

export class Group {
  id = `group-${Math.random().toString(36).slice(2)}`;
  position = obs<[number, number, number]>([0, 0, 0]);

  constructor(_cm: ContextManager, _props: Record<string, unknown>) {}

  appendChild(_child: Group): void {}
}
