"use strict";
// *****************************************************************************
// Copyright (C) 2020 Ericsson and others.
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
const inversify_1 = require("inversify");
const common_1 = require("../../common");
const core_preferences_1 = require("../../common/core-preferences");
const frontend_application_contribution_1 = require("../frontend-application-contribution");
const default_window_service_1 = require("./default-window-service");
const assert = require("assert");
const mock_logger_1 = require("../../common/test/mock-logger");
describe('DefaultWindowService', () => {
    class TestFrontendApplicationContribution {
        constructor(preventUnload) {
            this.preventUnload = preventUnload;
            this.onWillStopCalled = false;
        }
        onWillStop() {
            this.onWillStopCalled = true;
            return this.preventUnload;
        }
    }
    function setupWindowService(confirmExit, frontendContributions) {
        const container = new inversify_1.Container();
        container.bind(default_window_service_1.DefaultWindowService).toSelf().inSingletonScope();
        container.bind(common_1.ContributionProvider)
            .toConstantValue({
            getContributions: () => frontendContributions,
        })
            .whenTargetNamed(frontend_application_contribution_1.FrontendApplicationContribution);
        container.bind(core_preferences_1.CorePreferences)
            .toConstantValue({
            'application.confirmExit': confirmExit,
        });
        container.bind(common_1.ILogger).to(mock_logger_1.MockLogger).inSingletonScope();
        return container.get(default_window_service_1.DefaultWindowService);
    }
    it('onWillStop should be called on every contribution (never)', () => {
        const frontendContributions = [
            // preventUnload should be ignored here
            new TestFrontendApplicationContribution(true),
        ];
        const windowService = setupWindowService('never', frontendContributions);
        assert(frontendContributions.every(contribution => !contribution.onWillStopCalled), 'contributions should not be called yet');
        assert(windowService['collectContributionUnloadVetoes']().length === 0, 'there should be no vetoes');
        assert(frontendContributions.every(contribution => contribution.onWillStopCalled), 'contributions should have been called');
    });
    it('onWillStop should be called on every contribution (ifRequired)', () => {
        const frontendContributions = [
            new TestFrontendApplicationContribution(true),
            // canUnload should not stop at the previous contribution
            new TestFrontendApplicationContribution(false),
        ];
        const windowService = setupWindowService('ifRequired', frontendContributions);
        assert(frontendContributions.every(contribution => !contribution.onWillStopCalled), 'contributions should not be called yet');
        assert(windowService['collectContributionUnloadVetoes']().length > 0, 'There should be vetoes');
        assert(frontendContributions.every(contribution => contribution.onWillStopCalled), 'contributions should have been called');
    });
    it('onWillStop should be called on every contribution (always)', () => {
        const frontendContributions = [
            // canUnload should return false despite preventUnload not being set
            new TestFrontendApplicationContribution(false),
        ];
        const windowService = setupWindowService('always', frontendContributions);
        assert(frontendContributions.every(contribution => !contribution.onWillStopCalled), 'contributions should not be called yet');
        assert(windowService['collectContributionUnloadVetoes']().length > 0, 'there should be vetoes');
        assert(frontendContributions.every(contribution => contribution.onWillStopCalled), 'contributions should have been called');
    });
    it('should reload unconditionally when restored from the back/forward cache', () => {
        const frontendContributions = [
            new TestFrontendApplicationContribution(true),
        ];
        const windowService = setupWindowService('always', frontendContributions);
        let reloaded = 0;
        windowService.reload = () => { reloaded++; };
        windowService['handlePageShow']({ persisted: false });
        const reloadsBeforeRestore = reloaded;
        windowService['handlePageShow']({ persisted: true });
        assert(reloadsBeforeRestore === 0, 'a regular page show should not reload');
        assert(reloaded === 1, 'a restored page should reload');
        assert(windowService['collectContributionUnloadVetoes']().length === 0, 'the recovery reload should not be vetoed');
    });
    it('onUnload should fire at most once, even if `pagehide` fires repeatedly', () => {
        const windowService = setupWindowService('never', []);
        let fired = 0;
        windowService.onUnload(() => fired++);
        windowService['handlePageHide']();
        windowService['handlePageHide']();
        assert(fired === 1, `onUnload should have fired once, but fired ${fired} time(s)`);
    });
});
//# sourceMappingURL=default-window-service.spec.js.map