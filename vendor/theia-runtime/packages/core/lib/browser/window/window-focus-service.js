"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
exports.WindowFocusService = void 0;
const tslib_1 = require("tslib");
// based on https://github.com/microsoft/vscode/blob/ea6aac971b851ff8675f9ea04f8c0dfc36034a89/src/vs/workbench/services/host/browser/browserHostService.ts
// and https://github.com/microsoft/vscode/blob/ea6aac971b851ff8675f9ea04f8c0dfc36034a89/src/vs/base/browser/dom.ts#L1319 (FocusTracker)
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const inversify_1 = require("inversify");
const common_1 = require("../../common");
/**
 * Tracks focus state for each registered application window independently.
 *
 * The main window is registered automatically. Secondary windows should be
 * registered via {@link registerWindow} — typically by the service responsible
 * for creating them.
 *
 * Uses two complementary signals per window for robust detection:
 * - `window` `focus`/`blur` events (OS-level window focus changes)
 * - `document` `visibilitychange` events (browser tab switches)
 *
 * Blur events are debounced per window with `setTimeout(0)` so that focus
 * moving between elements within the same window does not produce a false
 * blur: the subsequent `focus` event cancels the pending blur before it fires.
 *
 * Each per-window event is latched — it only fires when that window's focus
 * state actually changes.
 */
let WindowFocusService = class WindowFocusService {
    constructor() {
        this.onDidWindowChangeFocusEmitter = new common_1.Emitter();
        /**
         * Fires when an individual window's focus state changes.
         * The event payload identifies which window changed and whether it gained or lost focus.
         *
         * A window losing focus to another application window will fire separately
         * for each window involved: one event with `hasFocus: false` for the window
         * that lost focus, and one with `hasFocus: true` for the window that gained it.
         */
        this.onDidWindowChangeFocus = this.onDidWindowChangeFocusEmitter.event;
        this.toDispose = new common_1.DisposableCollection(this.onDidWindowChangeFocusEmitter);
        /** Per-window tracking state. */
        this.windowStates = new Map();
    }
    init() {
        this.registerWindow(window);
    }
    /**
     * Register a window for focus tracking. The returned {@link Disposable}
     * removes the window from tracking when disposed.
     *
     * The main window is registered automatically. Call this for secondary
     * windows when they are created.
     */
    registerWindow(win) {
        if (this.windowStates.has(win)) {
            return common_1.Disposable.NULL;
        }
        const state = {
            lastFocusState: this.windowHasFocus(win),
            pendingBlurTimeout: undefined,
        };
        this.windowStates.set(win, state);
        const onFocus = () => this.handleFocus(win, state);
        const onBlur = () => this.scheduleBlur(win, state);
        const onVisibilityChange = () => this.updateWindowFocusState(win, state);
        win.addEventListener('focus', onFocus);
        win.addEventListener('blur', onBlur);
        win.document.addEventListener('visibilitychange', onVisibilityChange);
        const cleanup = common_1.Disposable.create(() => {
            this.cancelPendingBlur(state);
            this.windowStates.delete(win);
            win.removeEventListener('focus', onFocus);
            win.removeEventListener('blur', onBlur);
            try {
                win.document.removeEventListener('visibilitychange', onVisibilityChange);
            }
            catch {
                // The window may already be closed
            }
        });
        this.toDispose.push(cleanup);
        return cleanup;
    }
    /**
     * Whether any registered window currently has focus.
     */
    get hasFocus() {
        for (const win of this.windowStates.keys()) {
            if (this.windowHasFocus(win)) {
                return true;
            }
        }
        return false;
    }
    windowHasFocus(win) {
        try {
            return win.document.hasFocus();
        }
        catch {
            // The window may have been closed
            return false;
        }
    }
    handleFocus(win, state) {
        // Cancel this window's pending blur — focus arrived before the timeout,
        // meaning focus just moved between elements within this window.
        this.cancelPendingBlur(state);
        this.updateWindowFocusState(win, state);
    }
    /**
     * Schedule a deferred blur check for this specific window.
     * If no `focus` event arrives on this same window before the timeout fires,
     * we treat it as a real focus loss for that window.
     */
    scheduleBlur(win, state) {
        this.cancelPendingBlur(state);
        state.pendingBlurTimeout = setTimeout(() => {
            state.pendingBlurTimeout = undefined;
            this.updateWindowFocusState(win, state);
        }, 0);
    }
    cancelPendingBlur(state) {
        if (state.pendingBlurTimeout !== undefined) {
            clearTimeout(state.pendingBlurTimeout);
            state.pendingBlurTimeout = undefined;
        }
    }
    /**
     * Re-evaluate a single window's focus and fire if it changed (latching).
     */
    updateWindowFocusState(win, state) {
        const focused = this.windowHasFocus(win);
        if (focused !== state.lastFocusState) {
            state.lastFocusState = focused;
            this.onDidWindowChangeFocusEmitter.fire({ win, hasFocus: focused });
        }
    }
    dispose() {
        for (const state of this.windowStates.values()) {
            this.cancelPendingBlur(state);
        }
        this.toDispose.dispose();
    }
};
exports.WindowFocusService = WindowFocusService;
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], WindowFocusService.prototype, "init", null);
exports.WindowFocusService = WindowFocusService = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], WindowFocusService);
//# sourceMappingURL=window-focus-service.js.map