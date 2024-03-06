type Coords = {
  x: number;
  y: number;
  yaw: number;
};

interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface ROSPose {
  position: {
    x: number;
    y: number;
    z: number;
  };
  orientation: Quaternion;
}

export type EmergencyType = {
  isStop: boolean;
};

export type InsureMission = {
  locations: string;
};
export type IsReady = {
  isReady: boolean;
};

export type StatusType = {
  payload: string;
};

export type SimplePose = { x: number; y: number; yaw: number };

export type TrafficGoal = { type?: string; x: number; y: number; yaw: number };

export interface ROSPoseWithCovariance {
  pose: ROSPose;
  covariance: Array<number>;
}

export interface ROSHeader {
  seq?: number;
  stamp?: number;
  frame_id: string;
}

export interface ROSPoseStamped {
  header: ROSHeader;
  pose: ROSPose;
}

export const sanitizeDegree = (deg: number) => ((deg % 360) + 360) % 360;

export const yawToQuaternion = (yaw: number): Quaternion => {
  const theta = yaw * (Math.PI / 180);
  return {
    w: Math.cos(theta * 0.5),
    x: 0,
    y: 0,
    z: Math.sin(theta * 0.5),
  };
};

const quaternionToYaw = (quaternion: Quaternion) => {
  const { z, w } = quaternion;
  const sinYCosP = 2 * (w * z);
  const cosYCosP = 1 - 2 * (z * z);
  return sanitizeDegree(Math.atan2(sinYCosP, cosYCosP) * (180 / Math.PI));
};

export const quaternionObjToYaw = (quaternion: {
  x: number;
  y: number;
  z: number;
  w: number;
}) => {
  const { z, w } = quaternion;
  const sinYCosP = 2 * (w * z);
  const cosYCosP = 1 - 2 * (z * z);
  return sanitizeDegree(Math.atan2(sinYCosP, cosYCosP) * (180 / Math.PI));
};

export const coordsToRosPose = (pose: Coords): ROSPose => {
  const theta = pose.yaw * (Math.PI / 180);
  return {
    position: { x: pose.x, y: pose.y, z: 0 },
    orientation: {
      x: 0,
      y: 0,
      z: Math.sin(theta * 0.5),
      w: Math.cos(theta * 0.5),
    },
  };
};

export const tfTransformToCoords = (tfTransform: {
  translation: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}): Coords => {
  return {
    x: tfTransform.translation.x,
    y: tfTransform.translation.y,
    yaw: quaternionToYaw(tfTransform.rotation),
  };
};

export const coordsToRosPoseWithCovariance = (
  pose: Coords,
): ROSPoseWithCovariance => {
  const stdDevX = 0.5;
  const stdDevY = 0.5;
  const stdDevTheta = Math.PI / 12;
  const covariance = new Array(36).fill(0);
  covariance[6 * 0 + 0] = stdDevX * stdDevX;
  covariance[6 * 1 + 1] = stdDevY * stdDevY;
  covariance[6 * 5 + 5] = stdDevTheta * stdDevTheta;
  return {
    pose: coordsToRosPose(pose),
    covariance,
  };
};

export const angleDiff = (a: number, b: number) => {
  const diff = Math.abs(a - b);
  return Math.min(diff, 360 - diff);
};

export const isQuiteDifferentPose = (a: SimplePose, b: SimplePose) => {
  if (!a || !b) return true;
  return (
    Math.hypot(a.x - b.x, a.y - b.y) > 0.1 || angleDiff(a.yaw, b.yaw) > 0.75
  );
};

export const isDifferentPose = (
  a: SimplePose,
  b: SimplePose,
  toleranceDist: number = 0.0001,
  toleranceYaw: number = 0.001,
) => {
  if (!a || !b) return true;
  return (
    Math.hypot(a.x - b.x, a.y - b.y) > toleranceDist ||
    angleDiff(a.yaw, b.yaw) > toleranceYaw
  );
};
