import * as fs from "fs";
import * as path from "path";
import { kenmec_file_path } from "~/helpers/system";
import { errorLogger, infoLogger, warnLogger } from "~/logger/logger";
import { MISSION_STATUS, PENDING_READ_STATUS } from "~/types/status";

// The part of MISSION_STATUS that must survive an amr-core restart: the goal last forwarded
// to the AMR and a result QAMS has not acknowledged yet. Without it a restart mid-mission
// forgets the goal, and the reconcile after it can only guess (cancel + resend, or drop the
// result the AMR already produced).
type StoredMissionState = {
  missionType: string;
  lastSendGoalId: string;
  targetLoc: string;
  lastTransactionId: string;
  pendingReadStatus: PENDING_READ_STATUS | null;
};

// 跟 log (~/kenmec/_logs) 放一起, 不跟著啟動目錄走: 2026-11-12 現場 service 從 build/ 啟動,
// 手動重開時從上一層啟動, 讀到另一個 (空的) 存檔, 對帳判成「沒送到車上」重送.
// 同一台車的 service 跟手動啟動要用同一個 Linux 使用者, 不然家目錄不同還是會分開.
const STATE_FILE =
  process.env.MISSION_STATE_FILE || path.join(kenmec_file_path, "amr-core", "mission-state.json");

// 2026-11-12 以前的位置: <啟動目錄>/data; pkg 打包的執行檔也看執行檔旁邊的 data (service 從 build/ 啟動)
function legacyStateFiles(): string[] {
  if (process.env.MISSION_STATE_FILE) return [];
  const files = [path.resolve(process.cwd(), "data", "mission-state.json")];
  if ((process as { pkg?: unknown }).pkg) {
    files.push(path.join(path.dirname(process.execPath), "data", "mission-state.json"));
  }
  return [...new Set(files)].filter((f) => f !== STATE_FILE);
}

/** 存檔不在新位置時, 拿舊位置裡最新的一份, 馬上寫到新位置 (不然下次從別的目錄啟動又讀不到) */
function migrateLegacyStateFile(): void {
  if (fs.existsSync(STATE_FILE)) return;
  const found = legacyStateFiles()
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!found.length) return;
  const from = found[0].f;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.copyFileSync(from, STATE_FILE);
    infoLogger.info(`move mission record from ${from} to ${STATE_FILE}`, {
      title: "mission",
      type: "mission status",
      status: { candidates: found.map((c) => c.f) },
    });
  } catch (err) {
    warnLogger.warn(`can not move mission record from ${from} to ${STATE_FILE}`, {
      title: "mission",
      type: "mission status",
      status: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

export function loadMissionState(): StoredMissionState | null {
  try {
    migrateLegacyStateFile();
    if (!fs.existsSync(STATE_FILE)) {
      // 跟「有存檔但沒有任務」不一樣: 第一次啟動, 或存檔不見了 (對帳會當成 amr-core 沒有記錄)
      warnLogger.warn(`no mission record at ${STATE_FILE}, start without it`, {
        title: "mission",
        type: "mission status",
        status: { searched: [STATE_FILE, ...legacyStateFiles()] },
      });
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const state: StoredMissionState = {
      missionType: typeof raw.missionType === "string" ? raw.missionType : "",
      lastSendGoalId: typeof raw.lastSendGoalId === "string" ? raw.lastSendGoalId : "",
      targetLoc: typeof raw.targetLoc === "string" ? raw.targetLoc : "",
      lastTransactionId: typeof raw.lastTransactionId === "string" ? raw.lastTransactionId : "",
      pendingReadStatus:
        raw.pendingReadStatus && typeof raw.pendingReadStatus.id === "string" && raw.pendingReadStatus.read
          ? raw.pendingReadStatus
          : null,
    };
    infoLogger.info(`restore mission record from ${STATE_FILE}`, {
      title: "mission",
      type: "mission status",
      status: state,
    });
    return state;
  } catch (err) {
    // a broken file must not stop amr-core from starting - the reconcile handles "no record"
    warnLogger.warn(`can not read mission record ${STATE_FILE}, start without it`, {
      title: "mission",
      type: "mission status",
      status: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

export function saveMissionState(status: MISSION_STATUS) {
  const state: StoredMissionState = {
    missionType: status.missionType,
    lastSendGoalId: status.lastSendGoalId,
    targetLoc: status.targetLoc,
    lastTransactionId: status.lastTransactionId,
    pendingReadStatus: status.pendingReadStatus,
  };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    // write + fsync + rename so a crash or power cut mid-write leaves the previous record,
    // never half a file
    const tmp = `${STATE_FILE}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    errorLogger.error(`can not save mission record ${STATE_FILE}`, {
      title: "mission",
      type: "mission status",
      status: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}
