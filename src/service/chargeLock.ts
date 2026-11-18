import * as fs from "fs";
import * as path from "path";
import { kenmec_file_path } from "~/helpers/system";

/**
 * 充電鎖: QAMS 在充電站要伸充電桿前叫車端上鎖, 充電桿收好後解鎖。
 *
 * 上鎖期間:
 * - 每秒對車送一次立即暫停 (ROS 重連後也馬上送), 不靠 QAMS 一直重送。
 * - QAMS 送來的暫停 / 放行只放行「立即暫停」, 其他 (放行、做完再停) 擋下來;
 *   最後一個被擋下的會記著, 解鎖時補送 (恢復 QAMS 最後要的狀態)。
 * - 存檔: amr-core 重開還是鎖著, 直到 QAMS 解鎖。
 *
 * 所以 QAMS 掛掉、別的功能送了放行、或 amr-core / ROS 重開, 伸著充電桿的車都不會動。
 * 要手動解開 (QAMS 再也連不上, 充電桿確定收好了): 刪掉存檔 (預設
 * ~/kenmec/amr-core/charge-lock.json) 再重開 amr-core。
 */
export const CHARGE_LOCK_FILE =
  process.env.CHARGE_LOCK_FILE || path.join(kenmec_file_path, "amr-core", "charge-lock.json");

/** QAMS 的 Stop_Type: 0 放行, 1 做完目前動作再停, 2 立即暫停 */
const PAUSE_IMMEDIATELY = 2;
const REASSERT_MS = 1000;

type StoredLock = { locked: boolean; reason: string; since: number; dockLocationId: string };

type Log = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export type ChargeLockDeps = {
  /** 對車送暫停 / 放行 (ROS fleet_manager/pause), 內容是 QAMS 的 Pause_Payload JSON */
  publishPause: (payload: string) => void;
  isRosConnected: () => boolean;
  amrId: () => string;
  log: Log;
  file?: string;
  now?: () => number;
};

export type ChargeLockReply = { locked: boolean; paused: boolean };

function stopTypeOf(payload: string): number | null {
  try {
    const p = JSON.parse(payload);
    const t = p?.Body?.StopType;
    return typeof t === "number" ? t : null;
  } catch {
    return null;
  }
}

export class ChargeLock {
  private locked = false;
  private reason = "";
  private since = 0;
  // 哪一座充電站要車上鎖: 註冊時回報給 QAMS (QAMS 重開後還不知道車在哪, 靠這個知道車停在充電站上)
  private dock = "";
  // QAMS 最後要的暫停 / 放行 (原始內容); 解鎖時補送
  private lastRequested: string | null = null;
  private lastBlocked = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly now: () => number;

  constructor(private deps: ChargeLockDeps) {
    this.file = deps.file ?? CHARGE_LOCK_FILE;
    this.now = deps.now ?? (() => Date.now());
    const stored = this.load();
    if (stored?.locked) {
      this.locked = true;
      this.reason = stored.reason;
      this.since = stored.since;
      this.dock = stored.dockLocationId;
      this.deps.log.warn(`charge lock restored from ${this.file}: still locked (${stored.reason})`);
      this.startReassert();
    }
  }

  get isLocked() {
    return this.locked;
  }

  get state() {
    return {
      locked: this.locked,
      reason: this.reason,
      since: this.locked ? this.since : null,
      dockLocationId: this.locked ? this.dock : "",
    };
  }

  /** 註冊時告訴 QAMS: 鎖著沒、哪一座充電站鎖的 */
  get registerInfo() {
    return { locked: this.locked, dockLocationId: this.locked ? this.dock : "" };
  }

  /** QAMS 上 / 解鎖 */
  handle(lock: boolean, reason: string, dockLocationId = ""): ChargeLockReply {
    if (lock) {
      if (!this.locked || (dockLocationId && dockLocationId !== this.dock)) {
        this.locked = true;
        this.reason = reason;
        this.since = this.locked && this.since ? this.since : this.now();
        this.dock = dockLocationId || this.dock;
        this.save();
        this.deps.log.warn(`charge lock ON (dock ${this.dock || "?"}): ${reason}`);
      }
      const paused = this.pauseNow();
      this.startReassert();
      return { locked: true, paused };
    }

    if (!this.locked) return { locked: false, paused: false };
    this.locked = false;
    this.reason = "";
    this.dock = "";
    this.since = 0;
    this.save();
    this.stopReassert();
    this.deps.log.info(`charge lock OFF: ${reason}`);

    // 上鎖期間擋下的暫停 / 放行: 補送 QAMS 最後要的那一個
    if (this.lastBlocked && this.lastRequested !== null && this.deps.isRosConnected()) {
      this.deps.log.info("charge lock OFF: resend the last stop / resume QAMS asked for while locked");
      this.deps.publishPause(this.lastRequested);
    }
    this.lastBlocked = false;
    return { locked: false, paused: false };
  }

  /** QAMS 送來的暫停 / 放行: 送給車回 true, 上鎖中擋下回 false */
  onStopRequest(payload: string): boolean {
    this.lastRequested = payload;
    if (!this.locked || stopTypeOf(payload) === PAUSE_IMMEDIATELY) {
      this.lastBlocked = false;
      this.deps.publishPause(payload);
      return true;
    }
    this.lastBlocked = true;
    this.deps.log.warn(`charge lock ON (${this.reason}): drop a stop request that is not PAUSE_IMMEDIATELY`);
    return false;
  }

  /** ROS 重連: 鎖著就馬上補一個暫停 (ROS 重開後不記得暫停) */
  onRosConnected() {
    if (this.locked) this.pauseNow();
  }

  /** 停掉每秒的暫停 (程式結束 / 測試用) */
  dispose() {
    this.stopReassert();
  }

  private pauseNow(): boolean {
    if (!this.deps.isRosConnected()) return false;
    const now = this.now();
    this.deps.publishPause(
      JSON.stringify({
        Id: `charge-lock-${now}`,
        Action: "pauseTask",
        Time: now,
        Device: this.deps.amrId(),
        Body: { StopType: PAUSE_IMMEDIATELY },
      })
    );
    return true;
  }

  private startReassert() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.locked) this.pauseNow();
    }, REASSERT_MS);
    this.timer.unref?.();
  }

  private stopReassert() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private load(): StoredLock | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      const s = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (typeof s?.locked !== "boolean") return null;
      return {
        locked: s.locked,
        reason: String(s.reason ?? ""),
        since: Number(s.since) || 0,
        dockLocationId: String(s.dockLocationId ?? ""),
      };
    } catch (err) {
      // 存檔壞掉: 當成鎖著比較安全 (等 QAMS 連上來解鎖)
      this.deps.log.error(`charge lock file ${this.file} unreadable, treat as locked: ${err instanceof Error ? err.message : String(err)}`);
      return { locked: true, reason: "charge lock file unreadable", since: this.now(), dockLocationId: "" };
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ locked: this.locked, reason: this.reason, since: this.since, dockLocationId: this.dock })
      );
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.deps.log.error(`charge lock: can not write ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
