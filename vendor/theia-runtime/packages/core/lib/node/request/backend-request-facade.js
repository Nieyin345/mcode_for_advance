"use strict";
/********************************************************************************
 * Copyright (C) 2022 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
 ********************************************************************************/
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackendRequestFacade = exports.BackendRequestAllowedContribution = void 0;
exports.isUrlAllowed = isUrlAllowed;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
const request_1 = require("@theia/request");
const common_1 = require("../../common");
const backend_application_config_provider_1 = require("../backend-application-config-provider");
exports.BackendRequestAllowedContribution = Symbol('BackendRequestAllowedContribution');
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
function isUrlAllowed(url, allowedPatterns) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return false;
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        return false;
    }
    for (const pattern of allowedPatterns) {
        if (matchesPattern(parsed, pattern)) {
            return true;
        }
    }
    return false;
}
function matchesPattern(target, pattern) {
    let patternUrl;
    try {
        patternUrl = new URL(pattern);
    }
    catch {
        return false;
    }
    if (!ALLOWED_SCHEMES.has(patternUrl.protocol)) {
        return false;
    }
    if (target.protocol !== patternUrl.protocol) {
        return false;
    }
    const targetPort = getEffectivePort(target);
    const patternPort = getEffectivePort(patternUrl);
    if (targetPort !== patternPort) {
        return false;
    }
    return matchesHost(target.hostname, patternUrl.hostname);
}
function getEffectivePort(url) {
    if (url.port) {
        return url.port;
    }
    if (url.protocol === 'https:') {
        return '443';
    }
    if (url.protocol === 'http:') {
        return '80';
    }
    return '';
}
function matchesHost(targetHost, patternHost) {
    if (patternHost.startsWith('*.')) {
        const suffix = patternHost.substring(1); // e.g. ".example.com"
        return targetHost.endsWith(suffix) && targetHost.length > suffix.length;
    }
    return targetHost === patternHost;
}
let BackendRequestFacade = class BackendRequestFacade {
    async configure(config) {
        if (backend_application_config_provider_1.BackendApplicationConfigProvider.get().configureProxyFromPreferences) {
            return this.requestService.configure(config);
        }
    }
    async request(options) {
        const patterns = await this.getAllowedPatterns();
        const url = options.url;
        if (!url || !isUrlAllowed(url, patterns)) {
            throw new Error(`Request to URL '${url}' is not allowed. The URL does not match any allowed pattern.`);
        }
        const context = await this.requestService.request(options);
        return request_1.RequestContext.compress(context);
    }
    resolveProxy(url) {
        return this.requestService.resolveProxy(url);
    }
    async getAllowedPatterns() {
        if (this.cachedAllowedPatterns) {
            return this.cachedAllowedPatterns;
        }
        const patterns = [];
        if (this.allowedContributions) {
            for (const contribution of this.allowedContributions.getContributions()) {
                const contributed = await contribution.getAllowedUrlPatterns();
                patterns.push(...contributed);
            }
        }
        this.cachedAllowedPatterns = patterns;
        return patterns;
    }
};
exports.BackendRequestFacade = BackendRequestFacade;
tslib_1.__decorate([
    (0, inversify_1.inject)(request_1.RequestService),
    tslib_1.__metadata("design:type", Object)
], BackendRequestFacade.prototype, "requestService", void 0);
tslib_1.__decorate([
    (0, inversify_1.inject)(common_1.ContributionProvider),
    (0, inversify_1.named)(exports.BackendRequestAllowedContribution),
    (0, inversify_1.optional)(),
    tslib_1.__metadata("design:type", Object)
], BackendRequestFacade.prototype, "allowedContributions", void 0);
exports.BackendRequestFacade = BackendRequestFacade = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], BackendRequestFacade);
//# sourceMappingURL=backend-request-facade.js.map