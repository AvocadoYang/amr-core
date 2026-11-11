import Transport from "winston-transport";

/**
 * Forwards this amr-core's info / warn / error logs to QAMS, which writes them to
 * individual_agv/<car>/amrcore-<date>.log - so a disconnect can be debugged from the QAMS
 * machine without going to the car. Entries wait here while QAMS is unreachable and go out
 * after the reconnect (main.ts sends them), so what happened during the cut is not lost.
 */

export type ForwardEntry = {
  /** this machine's clock, epoch ms */
  t: number;
  lv: string;
  title?: string;
  type?: string;
  msg: string;
  /** the remaining fields as JSON, cut at META_MAX */
  meta?: string;
};

const MAX_ENTRIES = 2000;
const META_MAX = 2000;

let buffer: ForwardEntry[] = [];
let dropped = 0;

// a failed publish logs through errorLogger - forwarding that would feed itself
const skip = (title?: string, type?: string) =>
  title === "RabbitMQ" && (type === "rabbitmq service" || type === "publish");

const push = (entry: ForwardEntry) => {
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.shift();
    dropped++;
  }
};

export class ForwardTransport extends Transport {
  constructor() {
    super({ level: "info" });
  }

  log(info: any, callback: () => void) {
    try {
      const { level, message, title, type, ...rest } = info ?? {};
      if (!skip(title, type)) {
        let meta = "";
        if (Object.keys(rest).length) {
          try {
            meta = JSON.stringify(rest);
          } catch {
            meta = "[not serializable]";
          }
          if (meta.length > META_MAX) meta = `${meta.slice(0, META_MAX)}...`;
        }
        push({
          t: Date.now(),
          lv: String(level ?? "info"),
          title: title === undefined ? undefined : String(title),
          type: type === undefined ? undefined : String(type),
          msg: String(message ?? ""),
          meta: meta || undefined,
        });
      }
    } catch {
      // logging must never throw
    }
    callback();
  }
}

/** up to `max` oldest entries, plus how many were dropped because the buffer was full */
export function takeForwardBatch(max: number): { entries: ForwardEntry[]; dropped: number } {
  const entries = buffer.splice(0, max);
  const d = dropped;
  dropped = 0;
  return { entries, dropped: d };
}

/** a batch that could not be sent goes back to the front */
export function returnForwardBatch(entries: ForwardEntry[], d: number) {
  buffer = entries.concat(buffer);
  dropped += d;
  while (buffer.length > MAX_ENTRIES) {
    buffer.shift();
    dropped++;
  }
}
