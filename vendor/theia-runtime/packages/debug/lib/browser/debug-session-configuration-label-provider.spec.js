"use strict";
// *****************************************************************************
// Copyright (C) 2025 and others.
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
const frontend_application_config_provider_1 = require("@theia/core/lib/browser/frontend-application-config-provider");
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
const disableJSDOM = (0, jsdom_1.enableJSDOM)();
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const inversify_1 = require("@theia/core/shared/inversify");
const workspace_service_1 = require("@theia/workspace/lib/browser/workspace-service");
const chai_1 = require("chai");
const debug_session_configuration_label_provider_1 = require("./debug-session-configuration-label-provider");
disableJSDOM();
describe('DebugSessionConfigurationLabelProvider', () => {
    let roots = [];
    const tryGetRoots = () => roots;
    let labelProvider;
    before(() => {
        const container = new inversify_1.Container();
        container.bind(workspace_service_1.WorkspaceService).toConstantValue({
            tryGetRoots
        });
        container.bind(debug_session_configuration_label_provider_1.DebugSessionConfigurationLabelProvider).toSelf();
        labelProvider = container.get(debug_session_configuration_label_provider_1.DebugSessionConfigurationLabelProvider);
    });
    beforeEach(() => {
        roots = [];
    });
    it('should return the name', () => {
        const name = 'name';
        const label = labelProvider.getLabel({ name });
        (0, chai_1.expect)(label).to.be.equal(name);
    });
    it('should return the name with default params', () => {
        const name = 'name';
        const label = labelProvider.getLabel({ name, workspaceFolderUri: 'file:///workspace/folder/basename' });
        (0, chai_1.expect)(label).to.be.equal(name);
    });
    it('should return the multi-root name ignoring the workspace', () => {
        const name = 'name';
        const label = labelProvider.getLabel({ name, workspaceFolderUri: 'file:///workspace/folder/basename' }, true);
        (0, chai_1.expect)(label).to.be.equal('name (basename)');
    });
    it('should ignore the workspace and return the name without default params', () => {
        roots = [
            { /* irrelevant */},
            { /* irrelevant */},
        ];
        const name = 'name';
        const label = labelProvider.getLabel({ name }, false);
        (0, chai_1.expect)(label).to.be.equal(name);
    });
    it('should handle multi-workspace roots', () => {
        roots = [
            { /* irrelevant */},
            { /* irrelevant */},
        ];
        const name = 'name';
        const label = labelProvider.getLabel({ name, workspaceFolderUri: 'file:///workspace/root1/folder/basename' });
        (0, chai_1.expect)(label).to.be.equal('name (basename)');
    });
    it('should handle falsy basename and URI authority wins with multi-workspace roots', () => {
        roots = [
            { /* irrelevant */},
            { /* irrelevant */},
        ];
        const label = labelProvider.getLabel({ name: '', workspaceFolderUri: 'http://example.com' });
        (0, chai_1.expect)(label).to.be.equal(' (example.com)');
    });
});
//# sourceMappingURL=debug-session-configuration-label-provider.spec.js.map