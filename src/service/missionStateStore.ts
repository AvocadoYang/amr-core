import * as fs from "fs";
import * as path from "path";
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

const STATE_FILE =
  process.env.MISSION_STATE_FILE || path.resolve(process.cwd(), "data", "mission-state.json");

export function loadMissionState(): StoredMissionState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
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
