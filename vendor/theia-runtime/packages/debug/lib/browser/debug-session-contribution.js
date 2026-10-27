"use strict";
// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
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
exports.DefaultDebugSessionFactory = exports.DebugSessionFactory = exports.DebugSessionContributionRegistryImpl = exports.DebugSessionContributionRegistry = exports.DebugSessionContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const debug_session_1 = require("./debug-session");
const output_channel_1 = require("@theia/output/lib/browser/output-channel");
const debug_preferences_1 = require("../common/debug-preferences");
const debug_session_connection_1 = require("./debug-session-connection");
const debug_service_1 = require("../common/debug-service");
const contribution_provider_1 = require("@theia/core/lib/common/contribution-provider");
const service_connection_provider_1 = require("@theia/core/lib/browser/messaging/service-connection-provider");
/**
 * DebugSessionContribution symbol for DI.
 */
exports.DebugSessionContribution = Symbol('DebugSessionContribution');
/**
 * DebugSessionContributionRegistry symbol for DI.
 */
exports.DebugSessionContributionRegistry = Symbol('DebugSessionContributionRegistry');
let DebugSessionContributionRegistryImpl = class DebugSessionContributionRegistryImpl {
    constructor() {
        this.contribs = new Map();
    }
    init() {
        for (const contrib of this.contributions.getContributions()) {
            this.contribs.set(contrib.debugType, contrib);
        }
    }
    get(debugType) {
        return this.contribs.get(debugType);
    }
};
exports.DebugSessionContributionRegistryImpl = DebugSessionContributionRegistryImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(exports.DebugSessionContribution),
    tslib_1.__metadata("design:type", Object)
], DebugSessionContributionRegistryImpl.prototype, "contributions", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugSessionContributionRegistryImpl.prototype, "init", null);
exports.DebugSessionContributionRegistryImpl = DebugSessionContributionRegistryImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugSessionContributionRegistryImpl);
/**
 * DebugSessionFactory symbol for DI.
 */
exports.DebugSessionFactory = Symbol('DebugSessionFactory');
class DefaultDebugSessionFactory {
    constructor(container) {
        this.container = container;
    }
    createSession(sessionId, options, parentSession) {
        const connectionProvider = this.container.get(service_connection_provider_1.RemoteConnectionProvider);
        const connection = new debug_session_connection_1.DebugSessionConnection(sessionId, () => new Promise(resolve => connectionProvider.listen(`${debug_service_1.DebugAdapterPath}/${sessionId}`, (_, wsChannel) => {
            resolve(new debug_service_1.ForwardingDebugChannel(wsChannel));
        }, false)), this.getTraceOutputChannel());
        const data = {
            id: sessionId,
            options,
            parentSession,
        };
        const child = debug_session_1.DebugSession.createContainer(this.container, data, connection);
        return child.get(debug_session_1.DebugSession);
    }
    getTraceOutputChannel() {
        const outputChannelManager = this.container.get(output_channel_1.OutputChannelManager);
        const debugPreferences = this.container.get(debug_preferences_1.DebugPreferences);
        if (debugPreferences['debug.trace']) {
            return outputChannelManager.getChannel('Debug adapters');
        }
    }
}
exports.DefaultDebugSessionFactory = DefaultDebugSessionFactory;
//# sourceMappingURL=debug-session-contribution.js.map