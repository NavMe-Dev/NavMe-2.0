import { ContextManager } from './zcomponent-core';

type Observable<T> = { value: T };

function obs<T>(v: T): Observable<T> {
  return { value: v };
}

export class Point {
  position = obs<[number, number, number]>([0, 0, 0]);

  constructor(_cm: ContextManager, _props: Record<string, unknown>) {}

  remove(): void {}
}
