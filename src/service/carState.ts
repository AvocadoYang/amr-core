import * as ROS from "../ros";

// feedback older than this does not count as "the AMR is running that goal"
const FEEDBACK_FRESH_MS = 5000;

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
  private hasMissionWaiters: (() => void)[] = [];

  constructor() {
    ROS.has_mission.subscribe((hasMission) => {
      this.hasMission = hasMission;
      // idle now - the last feedback (a few seconds old at most) no longer means "running"
      if (!hasMission) this.feedbackGoalId = "";
      const waiters = this.hasMissionWaiters;
      this.hasMissionWaiters = [];
      waiters.forEach((resolve) => resolve());
    });

    ROS.getFeedbackFromMoveAction$.subscribe((feedback) => {
      this.feedbackGoalId = feedback.status.goal_id.id;
      this.feedbackAt = Date.now();
    });

    // a result ends that goal, even if its last feedback is still fresh
    ROS.getReadStatus$.subscribe((result) => {
      if (result.status.goal_id.id === this.feedbackGoalId) this.feedbackGoalId = "";
    });

    ROS.connectionClosed$.subscribe(() => {
      this.hasMission = null;
      this.feedbackGoalId = "";
      this.feedbackAt = 0;
    });
  }

  public getHasMission(): boolean | null {
    return this.hasMission;
  }

  /** goal id of feedback received in the last few seconds, otherwise null */
  public getRunningGoalId(): string | null {
    if (!this.feedbackGoalId || Date.now() - this.feedbackAt > FEEDBACK_FRESH_MS) return null;
    return this.feedbackGoalId;
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
