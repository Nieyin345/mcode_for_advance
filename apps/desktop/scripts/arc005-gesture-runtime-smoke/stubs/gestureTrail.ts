export const trail: string[] = [];
export function drawGestureTrail(): void { trail.push("draw"); }
export function fadeGestureTrail(): void { trail.push("fade"); }
export function showGestureBadge(): void { trail.push("badge"); }
