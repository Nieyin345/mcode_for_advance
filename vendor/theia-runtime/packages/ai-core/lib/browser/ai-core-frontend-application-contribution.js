"use strict";
// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
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
exports.AICoreFrontendApplicationContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const common_1 = require("../common");
const agent_service_1 = require("../common/agent-service");
const contribution_provider_1 = require("@theia/core/lib/common/contribution-provider");
let AICoreFrontendApplicationContribution = class AICoreFrontendApplicationContribution {
    onStart() {
        this.agentsProvider.getContributions().forEach(agent => {
            this.agentService.registerAgent(agent);
        });
    }
    onStop() {
    }
};
exports.AICoreFrontendApplicationContribution = AICoreFrontendApplicationContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(agent_service_1.AgentService),
    tslib_1.__metadata("design:type", Object)
], AICoreFrontendApplicationContribution.prototype, "agentService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(contribution_provider_1.ContributionProvider),
    (0, inversify_1.named)(common_1.Agent),
    tslib_1.__metadata("design:type", Object)
], AICoreFrontendApplicationContribution.prototype, "agentsProvider", void 0);
exports.AICoreFrontendApplicationContribution = AICoreFrontendApplicationContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AICoreFrontendApplicationContribution);
//# sourceMappingURL=ai-core-frontend-application-contribution.js.map