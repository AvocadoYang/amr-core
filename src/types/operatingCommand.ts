export type OperatingCommand =
  | { type: 'move'; x: number; y: number }
  | { type: 'stay'; x: number; y: number }
  | {
      type: 'park';
      x: number;
      y: number;
      yaw: number;
      locationId: string;
      xyGoalTolerance: number;
      yawGoalTolerance: number;
    }
  | { type: 'rotate'; yaw: number };

interface Goal {
  goal_id: {
    stamp: Record<string, any>;
    id: string;
  };
  status: number;
  text: string;
}

interface CurrentPose {
  current_pose: {
    header: Record<string, any>;
    pose: {
      position: {
        x: number;
        y: number;
        z: number;
      };
    };
  };
  id: number;
}

export type DataItem = Goal | CurrentPose;
