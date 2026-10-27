"use strict";
// *****************************************************************************
// Copyright (C) 2026 Alec Timison.
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
const jsdom_1 = require("../test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
const chai_1 = require("chai");
const widgets_1 = require("@theia/core/shared/@lumino/widgets");
const sinon = require("sinon");
const disposable_1 = require("../../common/disposable");
const application_shell_1 = require("./application-shell");
disableJSDOM();
describe('ApplicationShell', () => {
    let toTearDown;
    beforeEach(() => {
        toTearDown = (0, jsdom_1.enableJSDOM)();
    });
    afterEach(() => {
        sinon.restore();
        toTearDown();
    });
    it('cancels the previous activation check', () => {
        const shell = Object.create(application_shell_1.ApplicationShell.prototype);
        Object.assign(shell, {
            toDisposeOnActivationCheck: new disposable_1.DisposableCollection(),
            logger: { warn: sinon.stub() }
        });
        const assertActivated = shell.assertActivated.bind(shell);
        const firstWidget = new widgets_1.Widget();
        const secondWidget = new widgets_1.Widget();
        const request = {};
        sinon.stub(globalThis, 'setTimeout').returns(request);
        sinon.stub(window, 'setTimeout').returns(request);
        const clearTimeout = sinon.stub(window, 'clearTimeout');
        window.cancelAnimationFrame = sinon.stub();
        assertActivated(firstWidget);
        assertActivated(secondWidget);
        (0, chai_1.expect)(clearTimeout.callCount).to.equal(1);
        (0, chai_1.expect)(clearTimeout.firstCall.args[0]).to.equal(request);
        firstWidget.dispose();
        secondWidget.dispose();
    });
});
//# sourceMappingURL=application-shell.spec.js.map