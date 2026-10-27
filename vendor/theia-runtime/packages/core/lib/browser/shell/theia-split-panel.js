"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics and others.
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
exports.TheiaSplitPanel = void 0;
const widgets_1 = require("@lumino/widgets");
class TheiaSplitPanel extends widgets_1.SplitPanel {
    constructor(options) {
        super(options);
        let oldCursor;
        let pointerId;
        this['_evtPointerDown'] = (event) => {
            super['_evtPointerDown'](event);
            if (this['_pressData']) { // indicating that the drag has started
                this.node.setPointerCapture(event.pointerId);
                pointerId = event.pointerId;
                const layout = this.layout;
                const handle = layout.handles.find(h => h.contains(event.target));
                if (handle) {
                    const style = window.getComputedStyle(handle);
                    oldCursor = this.node.style.cursor;
                    this.node.style.cursor = style.cursor;
                }
            }
        };
        this['_releaseMouse'] = () => {
            super['_releaseMouse']();
            if (oldCursor !== undefined) {
                this.node.style.cursor = oldCursor;
                oldCursor = undefined;
            }
            if (pointerId) {
                this.node.releasePointerCapture(pointerId);
                pointerId = undefined;
            }
        };
    }
    handleEvent(event) {
        super.handleEvent(event);
    }
}
exports.TheiaSplitPanel = TheiaSplitPanel;
//# sourceMappingURL=theia-split-panel.js.map