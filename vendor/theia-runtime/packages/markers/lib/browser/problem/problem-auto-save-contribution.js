"use strict";
// *****************************************************************************
// Copyright (C) 2026 Safi Seid-Ahmad, K2view.
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
exports.ProblemAutoSaveContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const core_1 = require("@theia/core");
const vscode_languageserver_protocol_1 = require("@theia/core/shared/vscode-languageserver-protocol");
const problem_manager_1 = require("./problem-manager");
let ProblemAutoSaveContribution = class ProblemAutoSaveContribution {
    constructor() {
        this.onDidErrorStateChangeEmitter = new core_1.Emitter();
    }
    get onDidErrorStateChange() {
        return this.onDidErrorStateChangeEmitter.event;
    }
    init() {
        this.problemManager.onDidChangeMarkers(() => {
            this.onDidErrorStateChangeEmitter.fire();
        });
    }
    hasErrors(uri) {
        const markers = this.problemManager.findMarkers({ uri });
        return markers.some(marker => marker.data.severity === vscode_languageserver_protocol_1.DiagnosticSeverity.Error);
    }
};
exports.ProblemAutoSaveContribution = ProblemAutoSaveContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(problem_manager_1.ProblemManager),
    tslib_1.__metadata("design:type", problem_manager_1.ProblemManager)
], ProblemAutoSaveContribution.prototype, "problemManager", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], ProblemAutoSaveContribution.prototype, "init", null);
exports.ProblemAutoSaveContribution = ProblemAutoSaveContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], ProblemAutoSaveContribution);
//# sourceMappingURL=problem-auto-save-contribution.js.map