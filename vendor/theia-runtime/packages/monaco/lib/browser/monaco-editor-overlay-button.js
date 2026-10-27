"use strict";
// *****************************************************************************
// Copyright (C) 2025 1C-Soft LLC and others.
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
exports.MonacoEditorOverlayButton = void 0;
const core_1 = require("@theia/core");
const browser_1 = require("@theia/core/lib/browser");
const monaco = require("@theia/monaco-editor-core");
class MonacoEditorOverlayButton {
    static { this.nextId = 1; }
    constructor(editor, label, id = 'theia-editor.overlayButtonWidget' + MonacoEditorOverlayButton.nextId++) {
        this.onClickEmitter = new core_1.Emitter();
        this.onClick = this.onClickEmitter.event;
        this.toDispose = new core_1.DisposableCollection(this.onClickEmitter);
        this.domNode = document.createElement('div');
        this.domNode.classList.add('overlay-button');
        this.domNode.textContent = label;
        this.toDispose.push((0, browser_1.onDomEvent)(this.domNode, 'click', () => this.onClickEmitter.fire()));
        const overlayWidget = {
            getId: () => id,
            getDomNode: () => this.domNode,
            getPosition: () => ({
                preference: monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER
            })
        };
        editor.getControl().addOverlayWidget(overlayWidget);
        this.toDispose.push(core_1.Disposable.create(() => editor.getControl().removeOverlayWidget(overlayWidget)));
    }
    get enabled() {
        return !this.domNode.classList.contains(browser_1.DISABLED_CLASS);
    }
    set enabled(value) {
        if (value) {
            this.domNode.classList.remove(browser_1.DISABLED_CLASS);
        }
        else {
            this.domNode.classList.add(browser_1.DISABLED_CLASS);
        }
    }
    dispose() {
        this.toDispose.dispose();
    }
}
exports.MonacoEditorOverlayButton = MonacoEditorOverlayButton;
//# sourceMappingURL=monaco-editor-overlay-button.js.map