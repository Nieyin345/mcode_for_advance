"use strict";
// *****************************************************************************
// Copyright (C) 2024 Typefox and others.
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
exports.PreferenceCliContribution = void 0;
const tslib_1 = require("tslib");
const inversify_1 = require("@theia/core/shared/inversify");
const cli_preferences_1 = require("../common/cli-preferences");
const core_1 = require("@theia/core");
let PreferenceCliContribution = class PreferenceCliContribution {
    constructor() {
        this.preferences = [];
        this.sessionPreferences = [];
    }
    configure(conf) {
        conf.option('set-preference', {
            nargs: 1,
            desc: 'sets the specified preference (persisted to user settings)'
        });
        conf.option('session-preference', {
            nargs: 1,
            desc: 'sets the specified preference for this process only (in-memory, not persisted)'
        });
    }
    setArguments(args) {
        if (args.setPreference) {
            this.parseInto(args.setPreference, this.preferences);
        }
        if (args.sessionPreference) {
            this.parseInto(args.sessionPreference, this.sessionPreferences);
        }
    }
    parseInto(raw, target) {
        const entries = raw instanceof Array ? raw : [raw];
        target.push(...cli_preferences_1.CliPreferenceEntry.parseAll(entries, message => this.logger.warn(message)));
    }
    async getPreferences() {
        return this.preferences;
    }
    async getSessionPreferences() {
        return this.sessionPreferences;
    }
    /**
     * Forward `--session-preference` values to the remote backend when attaching
     * to a remote (e.g. dev container). Values are base64-encoded JSON to survive
     * shell argument parsing intact.
     */
    enhanceArgs(_context) {
        return this.sessionPreferences.map(entry => cli_preferences_1.CliPreferenceEntry.toArg('session-preference', entry));
    }
};
exports.PreferenceCliContribution = PreferenceCliContribution;
tslib_1.__decorate([
    (0, inversify_1.inject)(core_1.ILogger),
    (0, inversify_1.named)('preferences:PreferenceCliContribution'),
    tslib_1.__metadata("design:type", Object)
], PreferenceCliContribution.prototype, "logger", void 0);
exports.PreferenceCliContribution = PreferenceCliContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], PreferenceCliContribution);
//# sourceMappingURL=preference-cli-contribution.js.map