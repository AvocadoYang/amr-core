import {
  interval,
  mapTo,
  startWith,
  Subject,
  switchMap,
  takeUntil,
  timer,
} from 'rxjs';

const REPEAT_INTERVAL = 200;
const REPEAT_TIMEOUT = 15 * 1000;

export const repeat = <T extends Array<any>>(
  callback: (...args: T) => void,
) => {
  const subject = new Subject<T>();
  subject
    .pipe(
      switchMap((args: T) =>
        interval(REPEAT_INTERVAL).pipe(
          startWith(-1),
          takeUntil(timer(REPEAT_TIMEOUT)),
          mapTo(args),
        ),
      ),
    )
    .subscribe((args) => {
      callback(...args);
    });
  return (...args: T) => {
    subject.next(args);
  };
};

export default undefined;
