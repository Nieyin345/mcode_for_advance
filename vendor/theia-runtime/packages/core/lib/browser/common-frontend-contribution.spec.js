"use strict";
// *****************************************************************************
// Copyright (C) 2026 Safi Seid-Ahmad, K2view and others.
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
const jsdom_1 = require("./test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("./frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
// jsdom does not implement queryCommandSupported, which common-frontend-contribution
// evaluates at module load to determine cut/copy/paste support.
document.queryCommandSupported = () => false;
const chai = require("chai");
const event_1 = require("../common/event");
// Initialize the common barrel before common-frontend-contribution: its import graph contains
// cycles through the barrel (e.g. shell/tab-bar-toolbar) that leave injection tokens undefined
// when the contribution module itself is the entry point.
require("../common");
const common_frontend_contribution_1 = require("./common-frontend-contribution");
disableJSDOM();
const expect = chai.expect;
const OS_CLASSNAMES = [common_frontend_contribution_1.CLASSNAME_OS_MAC, common_frontend_contribution_1.CLASSNAME_OS_WINDOWS, common_frontend_contribution_1.CLASSNAME_OS_LINUX];
describe('CommonFrontendContribution', () => {
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
        document.queryCommandSupported = () => false;
    });
    after(() => {
        disableJSDOM();
    });
    describe('setOsClass', () => {
        let onWindowLoadedEmitter;
        let contribution;
        beforeEach(() => {
            document.body.classList.remove(...OS_CLASSNAMES);
            onWindowLoadedEmitter = new event_1.Emitter();
            // Bypass the constructor: setOsClass only uses the secondary window service,
            // and this keeps the test independent of the constructor's parameter list.
            contribution = Object.create(common_frontend_contribution_1.CommonFrontendContribution.prototype);
            /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
            contribution.secondaryWindowService = {
                onWindowLoaded: onWindowLoadedEmitter.event
            };
        });
        it('adds the OS class to the main window body', () => {
            contribution['setOsClass']();
            expect(OS_CLASSNAMES.filter(c => document.body.classList.contains(c))).to.have.lengthOf(1);
        });
        it('adds the OS class to a secondary window body once its document is loaded', () => {
            contribution['setOsClass']();
            const osClass = OS_CLASSNAMES.find(c => document.body.classList.contains(c));
            const body = document.createElement('body');
            const win = { document: { body } };
            onWindowLoadedEmitter.fire(win);
            expect(body.classList.contains(osClass), 'class must be added to the loaded window').to.be.true;
        });
    });
});
//# sourceMappingURL=common-frontend-contribution.spec.js.map