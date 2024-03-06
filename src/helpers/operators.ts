import { interval, map, Observable, withLatestFrom } from 'rxjs';

export const sampleInterval =
  (sampleTime: number) =>
  <T>(source$: Observable<T>) =>
    interval(sampleTime).pipe(
      withLatestFrom(source$),
      map(([, x]) => x),
    );

export default undefined;
