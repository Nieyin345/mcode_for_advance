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
exports.CliPreferenceEntry = exports.CliPreferencesPath = exports.CliPreferences = void 0;
exports.CliPreferences = Symbol('CliPreferences');
exports.CliPreferencesPath = '/services/cli-preferences';
var CliPreferenceEntry;
(function (CliPreferenceEntry) {
    const defaultWarn = message => console.warn(message);
    /**
     * Parses a single `KEY=JSONVALUE` preference assignment as accepted by `--set-preference`
     * and `--session-preference`. The value may be `base64:`-prefixed (used when forwarding
     * values that must survive shell/URL transport intact). Returns `undefined` (after logging a
     * warning to {@link warn}) when the entry has no key or the value is not valid JSON.
     */
    function parse(entry, warn = defaultWarn) {
        const firstEqualIndex = entry.indexOf('=');
        if (firstEqualIndex <= 0) {
            warn(`Ignoring preference CLI argument "${entry}": expected KEY=JSONVALUE.`);
            return undefined;
        }
        const rawValue = entry.substring(firstEqualIndex + 1);
        try {
            // Decoding happens inside the `try` so that a malformed `base64:` payload is reported
            // like any other invalid value instead of throwing out of `parse`.
            const value = rawValue.startsWith('base64:') ? decodeBase64(rawValue.substring('base64:'.length)) : rawValue;
            return [entry.substring(0, firstEqualIndex), JSON.parse(value)];
        }
        catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            warn(`Ignoring preference CLI argument "${entry}": value is not valid JSON (${reason}).`);
            return undefined;
        }
    }
    CliPreferenceEntry.parse = parse;
    /**
     * Formats a preference entry as a CLI argument of the form
     * `--<optionName>=<key>=base64:<base64(JSON(value))>`, the inverse of {@link parse}.
     *
     * The value is base64-encoded so it survives shell/URL transport intact (e.g. when the
     * argument is passed to a remote backend over an SSH command line).
     */
    function toArg(optionName, [key, value]) {
        return `--${optionName}=${key}=base64:${encodeBase64(JSON.stringify(value))}`;
    }
    CliPreferenceEntry.toArg = toArg;
    /**
     * Parses a list of `KEY=JSONVALUE` assignments, dropping any invalid entries and reporting
     * them to {@link warn}.
     */
    function parseAll(entries, warn = defaultWarn) {
        const result = [];
        for (const entry of entries) {
            const parsed = parse(entry, warn);
            if (parsed) {
                result.push(parsed);
            }
        }
        return result;
    }
    CliPreferenceEntry.parseAll = parseAll;
    // `Buffer` is available on the backend and is polyfilled into the frontend bundle by the
    // esbuild generator, so a single implementation covers both. It also handles UTF-8 directly,
    // unlike `atob`/`btoa`, which only deal in binary strings.
    function decodeBase64(value) {
        return Buffer.from(value, 'base64').toString('utf-8');
    }
    function encodeBase64(value) {
        return Buffer.from(value, 'utf-8').toString('base64');
    }
})(CliPreferenceEntry || (exports.CliPreferenceEntry = CliPreferenceEntry = {}));
//# sourceMappingURL=cli-preferences.js.map