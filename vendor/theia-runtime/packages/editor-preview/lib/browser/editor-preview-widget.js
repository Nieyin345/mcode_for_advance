"use strict";
// *****************************************************************************
// Copyright (C) 2021 Ericsson and others.
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
exports.EditorPreviewWidget = void 0;
const browser_1 = require("@theia/editor/lib/browser");
const common_1 = require("@theia/core/lib/common");
const preview_tab_widget_1 = require("./preview-tab-widget");
class EditorPreviewWidget extends browser_1.EditorWidget {
    get isPreview() {
        return this.previewSupport.isPreview;
    }
    get onDidChangePreviewState() {
        return this.previewSupport.onDidChangePreviewState;
    }
    constructor(editor, selectionService) {
        super(editor, selectionService);
        this.previewSupport = new preview_tab_widget_1.PreviewTabSupport({
            title: this.title,
            saveable: this.saveable,
            toDispose: this.toDispose,
            onConvertToNonPreview: () => this.tabBarTracker.reset()
        });
    }
    initializePreview() {
        this.previewSupport.initializePreview();
    }
    convertToNonPreview() {
        this.previewSupport.convertToNonPreview();
    }
    handleTabBarChange(oldTabBar, newTabBar) {
        super.handleTabBarChange(oldTabBar, newTabBar);
        this.previewSupport.handleTabBarChange(oldTabBar, newTabBar);
    }
    storeState() {
        if (this.getResourceUri()?.scheme !== common_1.UNTITLED_SCHEME) {
            return { isPreview: this.isPreview, editorState: this.editor.storeViewState() };
        }
    }
    restoreState(oldState) {
        if (!oldState.isPreview) {
            this.convertToNonPreview();
        }
        this.editor.restoreViewState(oldState.editorState);
    }
}
exports.EditorPreviewWidget = EditorPreviewWidget;
//# sourceMappingURL=editor-preview-widget.js.map