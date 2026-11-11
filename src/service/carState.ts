import { Subject } from "rxjs";
import * as ROS from "../ros";
import { infoLogger } from "../logger/logger";

// feedback older than this does not count as "the AMR is running that goal"
const FEEDBACK_FRESH_MS = 5000;
// no feedback for this long = the AMR stopped sending it (logged once)
const FEEDBACK_SILENT_MS = 3000;
const CAR_STATE_LOG = { title: "car", type: "car state" };
// the action server's goal status counts while its last message is this fresh (actionlib sends it ~5 Hz)
const STATUS_FRESH_MS = 3000;
// goal states that mean the AMR still holds the goal: PENDING, ACTIVE, PREEMPTING, RECALLING
const HELD_STATES = [0, 1, 6, 7];
// a pose change at least this big counts as "the AMR is moving"
const MOVED_DIST_M = 0.05;
const MOVED_DEG = 2;
const STATUS_MISSING_LOG_AFTER_MS = 10000;

const angleDiffDeg = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * What the AMR itself last said about its goal. This is kept apart from
 * amrStatus.amrHasMission, which stays true from the AMR taking a goal until QAMS acks the
 * result and ignores the AMR while QAMS is disconnected. Here every has_mission message
 * counts (true and false, connected or not), and everything is forgotten when the ROS
 * bridge drops, so after a reconnect only what the AMR said since then is reported.
 */
export default class CarState {
  // null = the AMR has not published has_mission since the ROS bridge (re)connected
  private hasMission: boolean | null = null;
  private feedbackGoalId = "";
  private feedbackAt = 0;
  // last time the AMR said has_mission=true
  private hasMissionTrueAt = 0;
  private hasMissionWaiters: (() => void)[] = [];
  /** goal id of every result the AMR publishes (any status: succeeded, preempted, rejected...) */
  public readonly goalEnded$ = new Subject<{ goalId: string; status: number }>();
  // what the AMR publishes, logged when it changes (the logs go to QAMS as well): shows whether an
  // AMR sends has_mission / feedback during a move without anyone running rostopic on the car
  private loggedHasMission: boolean | null = null;
  private hasMissionLoggedAt = 0;
  private hasMissionFlips = 0;
  private feedbackFlowing = false;
  private feedbackCount = 0;
  private feedbackSince = 0;
  private lastFeedbackGoalId = "";
  // the mission action server's goal status (actionlib), when this AMR publishes it: the only
  // signal that says which goal the AMR holds - some AMRs send has_mission=false and feedback only
  // in the first second of a goal (2026-11-11 site)
  private statusAt = 0;
  private heldGoalIds: string[] = [];
  private loggedHeld: string | null = null;
  // the AMR's movement: without the action status, a moving AMR still runs its goal
  private lastPose: { x: number; y: number; yaw: number } | null = null;
  private lastMovedAt = 0;

  constructor() {
    ROS.has_mission.subscribe((hasMission) => {
      this.hasMission = hasMission;
      if (hasMission) this.hasMissionTrueAt = Date.now();
      this.logHasMission(hasMission);
      // has_mission=false does NOT clear the feedback: some AMRs report has_mission=false for the
      // whole of a move while their feedback keeps coming (2026-11-11 site, the reconcile then
      // took a moving AMR for idle). A goal that really ended is cleared by its result below,
      // or goes stale after FEEDBACK_FRESH_MS.
      const waiters = this.hasMissionWaiters;
      this.hasMissionWaiters = [];
      waiters.forEach((resolve) => resolve());
    });

    ROS.getFeedbackFromMoveAction$.subscribe((feedback) => {
      this.feedbackGoalId = feedback.status.goal_id.id;
      this.feedbackAt = Date.now();
      this.logFeedback(this.feedbackGoalId);
    });
    setInterval(() => {
      this.logFeedbackStopped();
      // a change held back by the once-a-second limit, from an AMR that publishes only on change
      if (this.hasMission !== null) this.logHasMission(this.hasMission);
    }, 1000);

    ROS.missionGoalStatus$.subscribe((msg) => {
      this.statusAt = Date.now();
      this.heldGoalIds = (msg?.status_list ?? [])
        .filter((goal) => HELD_STATES.includes(Number(goal?.status)))
        .map((goal) => String(goal?.goal_id?.id ?? ""))
        .filter(Boolean);
      this.logHeldGoals();
      const waiters = this.hasMissionWaiters;
      this.hasMissionWaiters = [];
      waiters.forEach((resolve) => resolve());
    });

    ROS.pose$.subscribe((pose) => this.trackMovement(pose));
    ROS.connected$.subscribe(() => this.logRosTopics());

    // a result ends that goal, even if its last feedback is still fresh
    ROS.getReadStatus$.subscribe((result) => {
      if (result.status.goal_id.id === this.feedbackGoalId) this.feedbackGoalId = "";
      this.goalEnded$.next({ goalId: result.status.goal_id.id, status: result.status.status });
    });

    ROS.connectionClosed$.subscribe(() => {
      this.loggedHasMission = null;
      this.feedbackFlowing = false;
      this.hasMission = null;
      this.hasMissionTrueAt = 0;
      this.feedbackGoalId = "";
      this.feedbackAt = 0;
      this.statusAt = 0;
      this.heldGoalIds = [];
      this.loggedHeld = null;
      this.lastPose = null;
    });
  }

  private trackMovement(pose: { x: number; y: number; yaw: number }) {
    if (!pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.y)) return;
    if (!this.lastPose) {
      this.lastPose = pose;
      return;
    }
    const dist = Math.hypot(pose.x - this.lastPose.x, pose.y - this.lastPose.y);
    if (dist > MOVED_DIST_M || angleDiffDeg(pose.yaw, this.lastPose.yaw) > MOVED_DEG) {
      this.lastMovedAt = Date.now();
      this.lastPose = pose;
    }
  }

  private logHeldGoals() {
    const key = this.heldGoalIds.join(",");
    if (key === this.loggedHeld) return;
    if (this.loggedHeld === null) {
      infoLogger.info("車端有送 mission/status (actionlib): 用它判斷車上有沒有任務", {
        ...CAR_STATE_LOG,
        status: { held: this.heldGoalIds },
      });
    } else {
      infoLogger.info(key ? `車端 action status: 在跑 ${key}` : "車端 action status: 沒有任務", CAR_STATE_LOG);
    }
    this.loggedHeld = key;
  }

  /** once per ROS connection: which mission topics the AMR has, and whether it sends mission/status */
  private logRosTopics() {
    const connectedAt = Date.now();
    ROS.listTopics()
      .then(({ topics, types }) => {
        const relevant = topics
          .map((topic, i) => ({ topic, type: types[i] }))
          .filter(({ topic }) => topic.includes("/fleet_manager/") || topic.endsWith("/has_mission"));
        const hasStatus = relevant.some(({ topic }) => topic.endsWith("/fleet_manager/mission/status"));
        infoLogger.info(`車端任務相關 topic ${relevant.length} 個, ${hasStatus ? "有" : "沒有"} mission/status`, {
          ...CAR_STATE_LOG,
          status: { topics: relevant.map(({ topic, type }) => `${topic} (${type})`) },
        });
      })
      .catch((err) => {
        infoLogger.info(`讀不到車端的 topic 清單 (車上可能沒開 rosapi): ${err?.message ?? err}`, CAR_STATE_LOG);
      });
    setTimeout(() => {
      if (this.statusAt >= connectedAt) return;
      infoLogger.info("車端 10 秒內沒有送 mission/status: 用 has_mission / feedback / 有沒有在動判斷車上的任務", CAR_STATE_LOG);
    }, STATUS_MISSING_LOG_AFTER_MS);
  }

  /** the AMR publishes its action server's goal status (and did so in the last few seconds) */
  public usesActionStatus() {
    return this.statusAt > 0 && Date.now() - this.statusAt <= STATUS_FRESH_MS;
  }

  /** the AMR's pose changed within the last `ms` */
  public movedWithin(ms: number) {
    return this.lastMovedAt > 0 && Date.now() - this.lastMovedAt <= ms;
  }

  private logHasMission(hasMission: boolean) {
    if (hasMission === this.loggedHasMission) return;
    const now = Date.now();
    // an AMR flipping it many times a second is logged at most once a second
    if (now - this.hasMissionLoggedAt < 1000) {
      this.hasMissionFlips++;
      return;
    }
    infoLogger.info(`車端 has_mission ${this.loggedHasMission} -> ${hasMission}`, {
      ...CAR_STATE_LOG,
      status: {
        runningGoalId: this.getRunningGoalId(),
        ...(this.hasMissionFlips ? { flipsInLastSecond: this.hasMissionFlips } : {}),
      },
    });
    this.loggedHasMission = hasMission;
    this.hasMissionLoggedAt = now;
    this.hasMissionFlips = 0;
  }

  private logFeedback(goalId: string) {
    if (!this.feedbackFlowing) {
      this.feedbackFlowing = true;
      this.feedbackSince = this.feedbackAt;
      this.feedbackCount = 0;
      infoLogger.info(`車端開始送 feedback (goal ${goalId})`, {
        ...CAR_STATE_LOG,
        status: { hasMission: this.hasMission },
      });
    } else if (goalId !== this.lastFeedbackGoalId) {
      infoLogger.info(`車端 feedback 換成 goal ${goalId} (原本 ${this.lastFeedbackGoalId})`, {
        ...CAR_STATE_LOG,
        status: { hasMission: this.hasMission },
      });
    }
    this.feedbackCount++;
    this.lastFeedbackGoalId = goalId;
  }

  private logFeedbackStopped() {
    if (!this.feedbackFlowing || Date.now() - this.feedbackAt < FEEDBACK_SILENT_MS) return;
    this.feedbackFlowing = false;
    const secs = Math.max(1, (this.feedbackAt - this.feedbackSince) / 1000);
    infoLogger.info(
      `車端停止送 feedback: ${Math.round(secs)} 秒內共 ${this.feedbackCount} 筆 (約 ${(this.feedbackCount / secs).toFixed(1)} 筆/秒)`,
      { ...CAR_STATE_LOG, status: { lastGoalId: this.lastFeedbackGoalId, hasMission: this.hasMission } }
    );
  }

  /** with the action status: whether the AMR holds any goal; otherwise its has_mission */
  public getHasMission(): boolean | null {
    if (this.usesActionStatus()) return this.heldGoalIds.length > 0;
    return this.hasMission;
  }

  /**
   * with the action status: the goal the AMR holds; otherwise the goal of feedback received in the
   * last few seconds. null = none
   */
  public getRunningGoalId(): string | null {
    if (this.usesActionStatus()) return this.heldGoalIds[0] ?? null;
    if (!this.feedbackGoalId || Date.now() - this.feedbackAt > FEEDBACK_FRESH_MS) return null;
    return this.feedbackGoalId;
  }

  /** the AMR reported this goal: in its status / feedback, or has_mission=true after `since` */
  public reportsRunning(goalId: string, since: number) {
    if (this.getRunningGoalId() === goalId) return true;
    return !this.usesActionStatus() && this.hasMission === true && this.hasMissionTrueAt > since;
  }

  /** resolves once has_mission (or the action status) is known, or after timeoutMs if the AMR stays silent */
  public waitForHasMission(timeoutMs: number): Promise<void> {
    if (this.getHasMission() !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.hasMissionWaiters = this.hasMissionWaiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.hasMissionWaiters.push(done);
    });
  }
}
