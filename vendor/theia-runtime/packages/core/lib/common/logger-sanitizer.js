"use strict";
// *****************************************************************************
// Copyright (C) 2025 STMicroelectronics GmbH.
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
exports.DefaultLoggerSanitizer = exports.DefaultSanitizationRules = exports.LoggerSanitizer = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("inversify");
exports.LoggerSanitizer = Symbol('LoggerSanitizer');
/**
 * Checks if message might contain a URL with credentials.
 * Checks for :// (required for any URL) and @ (required for credentials).
 */
function mightContainUrlCredentials(message) {
    return message.includes('://') && message.includes('@');
}
/**
 * Checks if message might contain API key or auth token patterns.
 * Uses lowercase comparison for case-insensitive matching.
 */
function mightContainApiKeyOrToken(message) {
    const lower = message.toLowerCase();
    return (lower.includes('api') && lower.includes('key')) ||
        (lower.includes('auth') && lower.includes('token'));
}
/**
 * Default set of log sanitization rules.
 */
exports.DefaultSanitizationRules = [
    {
        /**
         * Regex pattern to match URLs with credentials.
         * Matches any URL with format: protocol://user:pass@host[:port]
         * Capture groups: $1=protocol, $2=username, $3=password, $4=host (with optional port)
         */
        pattern: /([a-z][a-z0-9+.-]*:\/\/)([^:/@]+):([^:/@]+)@([^/:@\s]+(?::\d+)?)/giu,
        replacement: '$1****:****@$4',
        precheck: mightContainUrlCredentials
    },
    {
        /**
         * Matches JSON-style key-value pairs for sensitive keys.
         * Handles both regular quotes and escaped quotes from JSON.stringify.
         * Examples: "apiKey": "value" or \"apiKey\": \"value\"
         * Capture groups: $1=key with opening quote of value, $2=closing quote of value
         */
        pattern: /(\\?["'][\w.-]*(?:api[_-]?key|auth[_-]?token)\\?["']\s*:\s*\\?["'])[^"'\\]+(\\?["'])/gi,
        replacement: '$1****$2',
        precheck: mightContainApiKeyOrToken
    }
];
/**
 * Default implementation of LoggerSanitizer that masks credentials in URLs.
 */
let DefaultLoggerSanitizer = class DefaultLoggerSanitizer {
    constructor() {
        this.rules = exports.DefaultSanitizationRules;
    }
    sanitize(message) {
        if (!message) {
            return message;
        }
        let result = message;
        for (const rule of this.rules) {
            if (!rule.precheck || rule.precheck(result)) {
                result = result.replace(rule.pattern, rule.replacement);
            }
        }
        return result;
    }
};
exports.DefaultLoggerSanitizer = DefaultLoggerSanitizer;
exports.DefaultLoggerSanitizer = DefaultLoggerSanitizer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultLoggerSanitizer);
//# sourceMappingURL=logger-sanitizer.js.map