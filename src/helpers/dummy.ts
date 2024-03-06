export function formatPose(pose: { x: number; y: number; yaw?: number }) {
  if (pose.yaw === undefined) {
    return `(${pose.x.toFixed(2)}, ${pose.y.toFixed(2)})`;
  }
  return `(${pose.x.toFixed(2)}, ${pose.y.toFixed(2)}, ${pose.yaw.toFixed(2)})`;
}
export default undefined;
