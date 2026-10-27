"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIActivationServiceImpl = exports.ENABLE_AI_CONTEXT_KEY = exports.AIActivationService = void 0;
const tslib_1 = require("tslib");
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
const inversify_1 = require("@theia/core/shared/inversify");
exports.AIActivationService = Symbol('AIActivationService');
const core_1 = require("@theia/core");
const context_key_service_1 = require("@theia/core/lib/browser/context-key-service");
/**
 * Context key for the AI features. It is set to `true` if the feature is enabled.
 */
exports.ENABLE_AI_CONTEXT_KEY = 'ai-features.AiEnable.enableAI';
/**
 * Default implementation of AIActivationService marks the feature active by default.
 *
 * Adopters may override this implementation to provide custom activation logic.
 *
 * Note that '@theia/ai-ide' also overrides this service to provide activation based on preferences,
 * disabling the feature by default.
 */
let AIActivationServiceImpl = class AIActivationServiceImpl {
    constructor() {
        this.isActive = true;
        this.canRun = true;
        this.onDidChangeAIEnabled = new core_1.Emitter();
        this.onDidChangeCanRunEmitter = new core_1.Emitter();
    }
    get onDidChangeActiveStatus() {
        return this.onDidChangeAIEnabled.event;
    }
    get onDidChangeCanRun() {
        return this.onDidChangeCanRunEmitter.event;
    }
    initialize() {
        this.contextKeyService.createKey(exports.ENABLE_AI_CONTEXT_KEY, true);
    }
};
exports.AIActivationServiceImpl = AIActivationServiceImpl;
tslib_1.__decorate([
    (0, inversify_1.inject)(context_key_service_1.ContextKeyService),
    tslib_1.__metadata("design:type", Object)
], AIActivationServiceImpl.prototype, "contextKeyService", void 0);
exports.AIActivationServiceImpl = AIActivationServiceImpl = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], AIActivationServiceImpl);
//# sourceMappingURL=ai-activation-service.js.map