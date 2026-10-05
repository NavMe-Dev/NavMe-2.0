import { createEmitter } from './zcomponent-core';

type Observable<T> = { value: T };

function obs<T>(v: T): Observable<T> {
  return { value: v };
}

export class NavigationRoute {
  originNode = obs('');
  destinationNode = obs('');
  cameraPositionOffset = obs<[number, number, number]>([0, 0, 0]);
  onRouteChange = createEmitter();
  onRouteInvalid = createEmitter<string>();

  appendChild(_pt: unknown): void {}
}
