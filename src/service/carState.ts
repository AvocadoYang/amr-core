import { Subject } from "rxjs";
import * as ROS from "../ros";
import { infoLogger } from "../logger/logger";

// feedback older than this does not count as "the AMR is running that goal"
const FEEDBACK_FRESH_MS = 5000;
// no feedback for this long = the AMR stopped sending it (logged once)
const FEEDBACK_SILENT_MS = 3000;
const CAR_STATE_LOG = { title: "car", type: "car state" };

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
    });
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

  public getHasMission(): boolean | null {
    return this.hasMission;
  }

  /** goal id of feedback received in the last few seconds, otherwise null */
  public getRunningGoalId(): string | null {
    if (!this.feedbackGoalId || Date.now() - this.feedbackAt > FEEDBACK_FRESH_MS) return null;
    return this.feedbackGoalId;
  }

  /** the AMR reported this goal: feedback with its id, or has_mission=true after `since` */
  public reportsRunning(goalId: string, since: number) {
    return this.getRunningGoalId() === goalId || (this.hasMission === true && this.hasMissionTrueAt > since);
  }

  /** resolves once has_mission is known, or after timeoutMs if the AMR stays silent */
  public waitForHasMission(timeoutMs: number): Promise<void> {
    if (this.hasMission !== null) return Promise.resolve();
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
