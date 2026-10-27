"use strict";
// *****************************************************************************
// Copyright (C) 2026 JuliaHub, Inc. and others.
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
exports.PreviewTabSupport = exports.PreviewTabWidget = exports.PREVIEW_TITLE_CLASS = void 0;
const browser_1 = require("@theia/core/lib/browser");
const widgets_1 = require("@theia/core/shared/@lumino/widgets");
const common_1 = require("@theia/core/lib/common");
exports.PREVIEW_TITLE_CLASS = 'theia-editor-preview-title-unpinned';
var PreviewTabWidget;
(function (PreviewTabWidget) {
    function is(arg) {
        return arg instanceof widgets_1.Widget
            && 'isPreview' in arg && typeof arg.isPreview === 'boolean'
            && 'onDidChangePreviewState' in arg && typeof arg.onDidChangePreviewState === 'function'
            && 'initializePreview' in arg && typeof arg.initializePreview === 'function'
            && 'convertToNonPreview' in arg && typeof arg.convertToNonPreview === 'function';
    }
    PreviewTabWidget.is = is;
    /**
     * Dispose every other preview widget sharing the target widget's tab-bar so that at most one
     * preview tab exists per editor group, regardless of the concrete preview widget types.
     */
    function disposeOtherPreviews(shell, widget) {
        if (!widget.isPreview) {
            return;
        }
        const tabbar = shell.getTabBarFor(widget);
        if (tabbar) {
            for (const title of tabbar.titles) {
                if (title.owner !== widget && is(title.owner) && title.owner.isPreview) {
                    title.owner.dispose();
                }
            }
        }
    }
    PreviewTabWidget.disposeOtherPreviews = disposeOtherPreviews;
})(PreviewTabWidget || (exports.PreviewTabWidget = PreviewTabWidget = {}));
/**
 * Reusable implementation of the {@link PreviewTabWidget} behavior. Widgets that cannot share a
 * common base class compose this and delegate their preview-related members to it.
 *
 * It only owns the preview *state* and its promotion triggers. Detecting a move between tab-bars is
 * left to the host (e.g. via `TabBarTracker`), which feeds {@link handleTabBarChange}; hosts whose
 * base class already tracks this (like `EditorWidget`) reuse that instead.
 */
class PreviewTabSupport {
    constructor(host) {
        this.host = host;
        this._isPreview = false;
        this.onDidChangePreviewStateEmitter = new common_1.Emitter();
        this.onDidChangePreviewState = this.onDidChangePreviewStateEmitter.event;
        this.host.toDispose.push(this.onDidChangePreviewStateEmitter);
    }
    get isPreview() {
        return this._isPreview;
    }
    initializePreview() {
        const oneTimeListeners = new common_1.DisposableCollection();
        this._isPreview = true;
        this.host.title.className += ` ${exports.PREVIEW_TITLE_CLASS}`;
        const oneTimeDirtyChangeListener = this.host.saveable.onDirtyChanged(() => {
            this.convertToNonPreview();
            oneTimeListeners.dispose();
        });
        oneTimeListeners.push(oneTimeDirtyChangeListener);
        const oneTimeTitleChangeHandler = () => {
            if (this.host.title.className.includes(browser_1.PINNED_CLASS)) {
                this.convertToNonPreview();
                oneTimeListeners.dispose();
            }
        };
        this.host.title.changed.connect(oneTimeTitleChangeHandler);
        oneTimeListeners.push(common_1.Disposable.create(() => this.host.title.changed.disconnect(oneTimeTitleChangeHandler)));
        this.host.toDispose.push(oneTimeListeners);
    }
    convertToNonPreview() {
        if (this._isPreview) {
            this._isPreview = false;
            this.host.onConvertToNonPreview?.();
            this.host.title.className = this.host.title.className.replace(exports.PREVIEW_TITLE_CLASS, '');
            this.onDidChangePreviewStateEmitter.fire();
            this.onDidChangePreviewStateEmitter.dispose();
        }
    }
    /**
     * Promote the preview to a permanent tab when it is moved between two tab-bars.
     */
    handleTabBarChange(oldTabBar, newTabBar) {
        if (this._isPreview && oldTabBar && newTabBar) {
            this.convertToNonPreview();
        }
    }
}
exports.PreviewTabSupport = PreviewTabSupport;
//# sourceMappingURL=preview-tab-widget.js.map