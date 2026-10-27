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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
// xterm.js is loaded transitively by the command contribution and probes canvas
// support at module-load time. These tests do not render a terminal.
const canvasProto = globalThis.HTMLCanvasElement?.prototype;
if (canvasProto) {
    canvasProto.getContext = () => undefined;
}
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const chai_1 = require("chai");
const plugin_vscode_commands_contribution_1 = require("./plugin-vscode-commands-contribution");
after(() => disableJSDOM());
function rect(left, top, width, height) {
    return { left, top, right: left + width, bottom: top + height, width, height };
}
describe('PluginVscodeCommandsContribution', () => {
    const contribution = new plugin_vscode_commands_contribution_1.PluginVscodeCommandsContribution();
    describe('findClosestEditorGroup', () => {
        it('prefers the orthogonally-overlapping group when navigating up out of a split column', () => {
            const left = rect(0, 0, 50, 100);
            const upperRight = rect(50, 0, 50, 50);
            const lowerRight = rect(50, 50, 50, 50);
            (0, chai_1.expect)(contribution['findClosestEditorGroup'](lowerRight, [left, upperRight], 'up')).to.equal(1);
        });
        it('navigates between columns in a 2x2 grid without skipping', () => {
            const topLeft = rect(0, 0, 50, 50);
            const topRight = rect(50, 0, 50, 50);
            const bottomLeft = rect(0, 50, 50, 50);
            const bottomRight = rect(50, 50, 50, 50);
            const candidates = [topRight, bottomLeft, bottomRight];
            (0, chai_1.expect)(contribution['findClosestEditorGroup'](topLeft, candidates, 'right')).to.equal(0);
            (0, chai_1.expect)(contribution['findClosestEditorGroup'](topLeft, candidates, 'down')).to.equal(1);
        });
        it('returns -1 when no candidate lies in the requested direction', () => {
            const left = rect(0, 0, 50, 100);
            const right = rect(50, 0, 50, 100);
            (0, chai_1.expect)(contribution['findClosestEditorGroup'](left, [right], 'left')).to.equal(-1);
            (0, chai_1.expect)(contribution['findClosestEditorGroup'](left, [right], 'up')).to.equal(-1);
            (0, chai_1.expect)(contribution['findClosestEditorGroup'](left, [], 'right')).to.equal(-1);
        });
    });
});
//# sourceMappingURL=plugin-vscode-commands-contribution.spec.js.map