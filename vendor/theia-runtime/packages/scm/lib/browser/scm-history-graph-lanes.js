"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource GmbH and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeGraphRows = computeGraphRows;
/** First color index of the default rotation (`scmGraph.foreground1`). */
const DEFAULT_COLOR_FIRST = 3;
/** Number of default rotation colors (`scmGraph.foreground1-5`). */
const DEFAULT_COLOR_COUNT = 5;
/**
 * Compute graph rows for an ordered list of commits (topological order,
 * newest first). Each commit must supply its own `id` and `parentIds`.
 *
 * @param commits Topologically sorted commits (newest → oldest).
 * @returns One `GraphRow` per commit in the same order.
 */
function computeGraphRows(commits) {
    // lanes[i] = id of commit that "owns" lane i (i.e. we are waiting for this
    // commit to appear in the list so we can close the lane).
    const lanes = [];
    // laneColors[i] = the color index currently assigned to lane i
    const laneColors = [];
    // Default lane colors rotate through foreground1-5, like VS Code's
    // color registry; indices 0-2 are reserved for ref-based colors.
    let rotation = -1;
    const nextDefaultColor = () => {
        rotation = (rotation + 1) % DEFAULT_COLOR_COUNT;
        return DEFAULT_COLOR_FIRST + rotation;
    };
    const rows = [];
    for (const commit of commits) {
        const parentIds = commit.parentIds ?? [];
        // --- 1. Find or assign a lane for this commit -----------------------
        let myLane = lanes.indexOf(commit.id);
        // hasTopLine: true when this commit was already reserved as a parent by
        // an earlier row — meaning there IS a connection coming from above.
        const hasTopLine = myLane !== -1;
        if (myLane === -1) {
            // Not yet tracked → open a new lane
            myLane = firstFreeLane(lanes);
            lanes[myLane] = commit.id;
            laneColors[myLane] = commit.colorIndex ?? nextDefaultColor();
        }
        // The segment above the commit keeps the color inherited from the
        // chain above; the commit's own ref color (if any) takes over from
        // this row downward.
        const topColor = laneColors[myLane] ?? DEFAULT_COLOR_FIRST;
        const myColor = commit.colorIndex ?? topColor;
        laneColors[myLane] = myColor;
        // Collect any duplicate lane occupants: other lanes that were kept
        // alive pointing at this same commit (sibling branch tips whose lane
        // was preserved until the parent row).  These emit merge-in edges and
        // are freed before the pass-through snapshot so they don't appear as
        // spurious pass-through lines on this row.
        const duplicateLanes = [];
        if (hasTopLine) {
            for (let li = 0; li < lanes.length; li++) {
                if (lanes[li] === commit.id && li !== myLane) {
                    duplicateLanes.push({ lane: li, color: laneColors[li] ?? DEFAULT_COLOR_FIRST });
                    lanes[li] = undefined;
                    laneColors[li] = undefined;
                }
            }
        }
        // --- 2. Snapshot current lane state before mutations ----------------
        const lanesCopy = lanes.slice();
        // --- 3. Determine parent lane assignments ---------------------------
        const parentLanes = [];
        // Track which parents were ALREADY in existing lanes (merge-in) vs new
        const parentIsExisting = [];
        for (let pi = 0; pi < parentIds.length; pi++) {
            const pid = parentIds[pi];
            const parentLane = lanesCopy.indexOf(pid);
            if (parentLane !== -1 && parentLane !== myLane) {
                if (hasTopLine) {
                    // Pre-reserved commit: parent already has a lane → merge-in edge on this row.
                    parentLanes.push(parentLane);
                    parentIsExisting.push(true);
                }
                else {
                    // Non-pre-reserved sibling branch tip: keep this lane alive so it
                    // passes through as a pass-through line until the parent row, where
                    // a merge-in is emitted via the duplicateLanes mechanism.
                    // No edge is emitted here; record myLane so hasContinuation is true.
                    lanes[myLane] = pid;
                    parentLanes.push(myLane);
                    parentIsExisting.push(false);
                }
            }
            else if (parentLane === myLane) {
                // First parent inherits this lane (fast-forward) — straight down
                parentLanes.push(myLane);
                parentIsExisting.push(false); // treated as inline continuation
            }
            else {
                // New parent → assign a lane
                if (pi === 0) {
                    // First parent continues in the same lane
                    lanes[myLane] = pid;
                    // Keep the same color as myLane for the first parent
                    parentLanes.push(myLane);
                    parentIsExisting.push(false);
                }
                else {
                    // Additional parents get new lanes — branch-out
                    const newLane = firstFreeLane(lanes);
                    lanes[newLane] = pid;
                    laneColors[newLane] = nextDefaultColor();
                    parentLanes.push(newLane);
                    parentIsExisting.push(false);
                }
            }
        }
        // If the commit has no parents (root commit), free the lane
        if (parentIds.length === 0) {
            lanes[myLane] = undefined;
            laneColors[myLane] = undefined;
        }
        else if (!parentLanes.includes(myLane)) {
            // No parent inherited myLane — decide whether to free or keep the lane.
            if (hasTopLine) {
                // Pre-reserved commit (merge convergence): free the lane immediately.
                lanes[myLane] = undefined;
                laneColors[myLane] = undefined;
            }
            else {
                // Non-pre-reserved sibling branch tip: keep the lane alive pointing
                // at the first parent so it persists as a pass-through until the
                // parent row.  At the parent row, the duplicate lane occupant is
                // detected and a merge-in edge is emitted there instead.
                lanes[myLane] = parentIds[0];
            }
        }
        // --- 4. Emit edges --------------------------------------------------
        const edges = [];
        // Pass-through lines: lanes that were occupied before this row and
        // are NOT the commit's own lane continue straight through.
        for (let li = 0; li < lanesCopy.length; li++) {
            const occupant = lanesCopy[li];
            if (!occupant || occupant === commit.id) {
                continue;
            }
            const color = laneColors[li] ?? DEFAULT_COLOR_FIRST;
            edges.push({ fromLane: li, toLane: li, color, type: 'pass-through' });
        }
        for (let pi = 0; pi < parentIds.length; pi++) {
            const toLane = parentLanes[pi];
            const isExisting = parentIsExisting[pi];
            if (toLane === myLane) {
                // First parent continues in the same lane — no edge is emitted.
                // The vertical connection is represented by hasContinuation:true on
                // this row and hasTopLine:true on the parent's row; the SVG renderer
                // draws the top/bottom line segments around the commit circle instead.
                continue;
            }
            if (isExisting) {
                // Merge-in: an existing lane at the top of the row curves into
                // the commit position at mid-row.
                const color = laneColors[toLane] ?? DEFAULT_COLOR_FIRST;
                edges.push({ fromLane: toLane, toLane: myLane, color, type: 'merge-in' });
            }
            else {
                // Branch-out: the commit spawns a new lane below mid-row.
                const color = laneColors[toLane] ?? DEFAULT_COLOR_FIRST;
                edges.push({ fromLane: myLane, toLane, color, type: 'branch-out' });
            }
        }
        // Merge-in edges for duplicate lane occupants (sibling branch tips
        // converging into this commit's lane).
        for (const dl of duplicateLanes) {
            edges.push({ fromLane: dl.lane, toLane: myLane, color: dl.color, type: 'merge-in' });
        }
        // hasContinuation: true if the first parent continues in the same lane,
        // OR if this is a sibling branch tip whose lane was kept alive (pointing
        // at the parent) so it persists as a pass-through to the parent row.
        const hasContinuation = parentIds.length > 0 && (parentLanes[0] === myLane || lanes[myLane] === parentIds[0]);
        rows.push({ lane: myLane, color: myColor, topColor, edges, hasContinuation, hasTopLine });
    }
    return rows;
}
/** Returns the index of the first undefined slot, or lanes.length if full. */
function firstFreeLane(lanes) {
    const idx = lanes.indexOf(undefined);
    return idx === -1 ? lanes.length : idx;
}
//# sourceMappingURL=scm-history-graph-lanes.js.map