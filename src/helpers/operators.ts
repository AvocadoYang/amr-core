import { filter, interval, map, Observable, OperatorFunction, withLatestFrom } from 'rxjs';
import { isOfType } from 'typesafe-actions';
export const sampleInterval =
  (sampleTime: number) =>
    <T>(source$: Observable<T>) =>
      interval(sampleTime).pipe(
        withLatestFrom(source$),
        map(([, x]) => x),
      );

export default undefined;


export function ofType<T extends string, A extends { type: string }>(
  t: T | T[],
): OperatorFunction<A, A extends { type: T } ? A : never> {
  return (source$) => source$.pipe(filter(isOfType(t)));
}