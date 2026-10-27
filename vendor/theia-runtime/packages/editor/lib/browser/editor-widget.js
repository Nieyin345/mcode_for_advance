"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
exports.EditorWidget = void 0;
const common_1 = require("@theia/core/lib/common");
const browser_1 = require("@theia/core/lib/browser");
class EditorWidget extends browser_1.BaseWidget {
    constructor(editor, selectionService) {
        super(editor);
        this.editor = editor;
        this.selectionService = selectionService;
        this.tabBarTracker = new browser_1.TabBarTracker(this, (oldTabBar, newTabBar) => this.handleTabBarChange(oldTabBar, newTabBar));
        this.isExtractable = true;
        this.navigationHistorySupport = true;
        this.addClass('theia-editor');
        if (editor.isReadonly) {
            (0, browser_1.lock)(this.title);
        }
        this.toDispose.push(this.editor);
        this.toDispose.push(this.editor.onSelectionChanged(() => this.setSelection()));
        this.toDispose.push(this.editor.onFocusChanged(() => this.setSelection()));
        this.toDispose.push(this.editor.onDidChangeReadOnly(isReadonly => {
            if (isReadonly) {
                (0, browser_1.lock)(this.title);
            }
            else {
                (0, browser_1.unlock)(this.title);
            }
        }));
        this.toDispose.push(this.tabBarTracker);
        this.toDispose.push(common_1.Disposable.create(() => {
            if (this.selectionService.selection === this.editor) {
                this.selectionService.selection = undefined;
            }
        }));
    }
    setSelection() {
        if (this.editor.isFocused() && this.selectionService.selection !== this.editor) {
            this.selectionService.selection = this.editor;
        }
    }
    handleVisiblityChanged(isNowVisible) {
        this.editor.handleVisibilityChanged(isNowVisible);
        super.handleVisiblityChanged(isNowVisible);
    }
    get saveable() {
        return this.editor.document;
    }
    getResourceUri() {
        return this.editor.getResourceUri();
    }
    createMoveToUri(resourceUri) {
        return this.editor.createMoveToUri(resourceUri);
    }
    getPreviewNode() {
        if (!this.isVisible && this.editor.stageForPreview) {
            this.editor.stageForPreview();
            queueMicrotask(() => this.editor.unstagePreview?.());
        }
        return this.node;
    }
    onActivateRequest(msg) {
        super.onActivateRequest(msg);
        this.editor.focus();
        this.selectionService.selection = this.editor;
    }
    onAfterAttach(msg) {
        super.onAfterAttach(msg);
        if (this.isVisible) {
            this.editor.refresh();
        }
        this.tabBarTracker.check();
    }
    handleTabBarChange(oldTabBar, newTabBar) {
        const ownSaveable = browser_1.Saveable.get(this);
        const competingEditors = ownSaveable && newTabBar?.titles.filter(title => title !== this.title
            && (title.owner instanceof EditorWidget)
            && title.owner.editor.uri.isEqual(this.editor.uri)
            && browser_1.Saveable.get(title.owner) === ownSaveable);
        competingEditors?.forEach(title => title.owner.close());
    }
    onAfterShow(msg) {
        super.onAfterShow(msg);
        this.editor.refresh();
    }
    onResize(msg) {
        if (msg.width < 0 || msg.height < 0) {
            this.editor.resizeToFit();
        }
        else {
            this.editor.setSize(msg);
        }
    }
    storeState() {
        return this.getResourceUri()?.scheme === common_1.UNTITLED_SCHEME ? undefined : this.editor.storeViewState();
    }
    restoreState(oldState) {
        this.editor.restoreViewState(oldState);
    }
    get onDispose() {
        return this.toDispose.onDispose;
    }
}
exports.EditorWidget = EditorWidget;
//# sourceMappingURL=editor-widget.js.map