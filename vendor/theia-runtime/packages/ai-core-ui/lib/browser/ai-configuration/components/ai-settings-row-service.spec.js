"use strict";
// *****************************************************************************
// Copyright (C) 2026 EclipseSource and others.
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
const jsdom_1 = require("@theia/core/lib/browser/test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const common_1 = require("@theia/core/lib/common");
const ai_core_preferences_1 = require("@theia/ai-core/lib/common/ai-core-preferences");
const preference_types_1 = require("@theia/preferences/lib/browser/util/preference-types");
const chai_1 = require("chai");
const ai_settings_row_service_1 = require("./ai-settings-row-service");
disableJSDOM();
class FakeAiConfigurationService {
    constructor() {
        this.inspection = {};
        this.sets = [];
    }
    inspect() {
        return {
            preferenceName: 'test',
            defaultValue: undefined,
            globalValue: undefined,
            workspaceValue: undefined,
            workspaceFolderValue: undefined,
            value: undefined,
            ...this.inspection
        };
    }
    set(preferenceId, value, scope, resourceUri) {
        this.sets.push({ preferenceId, value, scope, resourceUri });
        return Promise.resolve();
    }
}
function createService(inspection) {
    const preferences = new FakeAiConfigurationService();
    preferences.inspection = inspection;
    const service = new ai_settings_row_service_1.AiSettingsRowService();
    service.aiConfigurationService = preferences;
    return { service, preferences };
}
function createServiceWithSchema(property) {
    const service = new ai_settings_row_service_1.AiSettingsRowService();
    const schemaService = {
        getSchemaProperty: () => property
    };
    service.schemaService = schemaService;
    return service;
}
describe('AiSettingsRowService', () => {
    before(() => disableJSDOM = (0, jsdom_1.enableJSDOM)());
    after(() => disableJSDOM());
    describe('inspect', () => {
        it('resolves the user-scope value falling back to the default', () => {
            const { service } = createService({ defaultValue: 'd', globalValue: undefined });
            const result = service.inspect('pref', 'user');
            (0, chai_1.expect)(result.value).to.equal('d');
            (0, chai_1.expect)(result.scopeValue).to.equal(undefined);
            (0, chai_1.expect)(result.modified).to.equal(false);
        });
        it('reports a user-scope override as modified', () => {
            const { service } = createService({ defaultValue: 'd', globalValue: 'u' });
            const result = service.inspect('pref', 'user');
            (0, chai_1.expect)(result.value).to.equal('u');
            (0, chai_1.expect)(result.scopeValue).to.equal('u');
            (0, chai_1.expect)(result.modified).to.equal(true);
        });
        it('resolves the workspace value falling back through user then default', () => {
            const { service } = createService({ defaultValue: 'd', globalValue: 'u' });
            const workspace = service.inspect('pref', 'workspace');
            (0, chai_1.expect)(workspace.value).to.equal('u');
            (0, chai_1.expect)(workspace.scopeValue).to.equal(undefined);
            (0, chai_1.expect)(workspace.modified).to.equal(false);
            const { service: service2 } = createService({ defaultValue: 'd', globalValue: 'u', workspaceValue: 'w' });
            const workspace2 = service2.inspect('pref', 'workspace');
            (0, chai_1.expect)(workspace2.value).to.equal('w');
            (0, chai_1.expect)(workspace2.modified).to.equal(true);
        });
        it('resolves the folder value falling back through workspace, user then default', () => {
            const { service } = createService({ defaultValue: 'd', globalValue: 'u', workspaceValue: 'w' });
            const folder = service.inspect('pref', 'folder');
            (0, chai_1.expect)(folder.value).to.equal('w');
            (0, chai_1.expect)(folder.modified).to.equal(false);
            const { service: service2 } = createService({ defaultValue: 'd', workspaceFolderValue: 'f' });
            const folder2 = service2.inspect('pref', 'folder');
            (0, chai_1.expect)(folder2.value).to.equal('f');
            (0, chai_1.expect)(folder2.modified).to.equal(true);
        });
        it('treats a value of `false` as an explicit override (not inherited)', () => {
            const { service } = createService({ defaultValue: true, globalValue: false });
            const result = service.inspect('pref', 'user');
            (0, chai_1.expect)(result.value).to.equal(false);
            (0, chai_1.expect)(result.modified).to.equal(true);
        });
    });
    describe('controlFor', () => {
        it('maps primitive schema types to their inline controls', () => {
            (0, chai_1.expect)(createServiceWithSchema({ type: 'boolean' }).controlFor('pref').type).to.equal('boolean');
            (0, chai_1.expect)(createServiceWithSchema({ type: 'number' }).controlFor('pref').type).to.equal('number');
            (0, chai_1.expect)(createServiceWithSchema({ type: 'integer' }).controlFor('pref').type).to.equal('number');
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string' }).controlFor('pref').type).to.equal('string');
            (0, chai_1.expect)(createServiceWithSchema(undefined).controlFor('pref').type).to.equal('string');
        });
        it('marks only an integer schema as whole-number, so a number keeps what the user typed', () => {
            // Both render the stepper; only the integer one may round on commit.
            (0, chai_1.expect)(createServiceWithSchema({ type: 'integer' }).controlFor('pref')).to.deep.include({ type: 'number', integer: true });
            (0, chai_1.expect)(createServiceWithSchema({ type: 'number' }).controlFor('pref')).to.not.have.property('integer');
        });
        it('maps an enum to a select regardless of its base type', () => {
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string', enum: ['a', 'b'] }).controlFor('pref').type).to.equal('select');
        });
        it('masks secret string preferences (API keys/tokens) with a password input', () => {
            const control = createServiceWithSchema({ type: 'string' }).controlFor('ai-features.anthropic.apiKey');
            (0, chai_1.expect)(control).to.deep.include({ type: 'string', password: true });
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string' }).controlFor('ai-features.anthropic.model'))
                .to.deep.include({ type: 'string', password: false });
        });
        it('renders the inline list editor for string arrays', () => {
            (0, chai_1.expect)(createServiceWithSchema({ type: 'array', items: { type: 'string' } }).controlFor('pref').type).to.equal('array');
        });
        it('defers object and non-string-array preferences to the Settings UI via a json control', () => {
            (0, chai_1.expect)(createServiceWithSchema({ type: 'object' }).controlFor('pref').type).to.equal('json');
            (0, chai_1.expect)(createServiceWithSchema({ type: 'array', items: { type: 'object' } }).controlFor('pref').type).to.equal('json');
            (0, chai_1.expect)(createServiceWithSchema({ type: 'array', items: { type: 'number' } }).controlFor('pref').type).to.equal('json');
        });
    });
    describe('enumOptions', () => {
        it('uses the value as the label and enumDescriptions as the option description (never the description as the label)', () => {
            const options = createServiceWithSchema({
                type: 'string',
                enum: ['default', 'enabled'],
                enumDescriptions: ['Use the default', 'Force enabled']
            }).enumOptions('pref');
            (0, chai_1.expect)(options).to.deep.equal([
                { value: 'default', label: 'default', description: 'Use the default' },
                { value: 'enabled', label: 'enabled', description: 'Force enabled' }
            ]);
        });
        it('prefers an explicit enumItemLabels entry for the label', () => {
            const options = createServiceWithSchema({
                type: 'string',
                enum: ['a'],
                enumItemLabels: ['Option A'],
                enumDescriptions: ['desc']
            }).enumOptions('pref');
            (0, chai_1.expect)(options[0]).to.deep.equal({ value: 'a', label: 'Option A', description: 'desc' });
        });
        it('returns an empty list when the property declares no enum', () => {
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string' }).enumOptions('pref')).to.deep.equal([]);
        });
    });
    describe('isDisplayable', () => {
        it('rejects the value-less placeholders that only redirect to this view', () => {
            // eslint-disable-next-line no-null/no-null
            (0, chai_1.expect)(createServiceWithSchema({ type: 'null' }).isDisplayable('ai-features.openConfiguration')).to.equal(false);
        });
        it('rejects a preference the view edits through a control of its own', () => {
            const property = { type: 'array', typeDetails: { [ai_core_preferences_1.DEDICATED_EDITOR_TYPE_DETAIL]: true } };
            // The provider pages mark the offered models; a raw list of ids next to them would be a second, worse editor.
            (0, chai_1.expect)(createServiceWithSchema(property).isDisplayable('ai-features.modelSettings.favoriteModels')).to.equal(false);
        });
        it('accepts an ordinary preference', () => {
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string' }).isDisplayable('ai-features.anthropic.AnthropicApiKey')).to.equal(true);
        });
    });
    describe('modelProviderLabel', () => {
        it('returns the provider label declared under the aiModelProvider typeDetails', () => {
            const service = createServiceWithSchema({ type: 'string', typeDetails: { aiModelProvider: { label: 'Anthropic' } } });
            (0, chai_1.expect)(service.modelProviderLabel('pref')).to.equal('Anthropic');
        });
        it('returns undefined when no provider label is declared', () => {
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string' }).modelProviderLabel('pref')).to.equal(undefined);
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string', typeDetails: { other: 'x' } }).modelProviderLabel('pref')).to.equal(undefined);
            // The metadata must be an object carrying a string `label`.
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string', typeDetails: { aiModelProvider: 'Anthropic' } }).modelProviderLabel('pref')).to.equal(undefined);
            (0, chai_1.expect)(createServiceWithSchema({ type: 'string', typeDetails: { aiModelProvider: { label: 42 } } }).modelProviderLabel('pref')).to.equal(undefined);
            (0, chai_1.expect)(createServiceWithSchema(undefined).modelProviderLabel('pref')).to.equal(undefined);
        });
    });
    describe('editInSettings', () => {
        it('opens settings.json focused on the preference via the preferences JSON command', () => {
            const executed = [];
            const service = new ai_settings_row_service_1.AiSettingsRowService();
            service.commandService = {
                executeCommand: (command, ...args) => {
                    executed.push({ command, args });
                    return Promise.resolve(undefined);
                }
            };
            service.editInSettings('my.pref');
            (0, chai_1.expect)(executed).to.deep.equal([{ command: preference_types_1.PreferencesCommands.OPEN_PREFERENCES_JSON_TOOLBAR.id, args: ['my.pref'] }]);
        });
    });
    describe('normalizeMarkdown', () => {
        const normalize = (markdown) => new ai_settings_row_service_1.AiSettingsRowService().normalizeMarkdown(markdown);
        it('strips the shared indentation of continuation lines so lists render as lists', () => {
            const raw = [
                'Allows custom settings.',
                '            Each setting consists of:',
                '            - `scope`: when it applies',
                '              - `modelId` (optional)',
                '            - `requestSettings`: values'
            ].join('\n');
            const expected = [
                'Allows custom settings.',
                'Each setting consists of:',
                '- `scope`: when it applies',
                '  - `modelId` (optional)',
                '- `requestSettings`: values'
            ].join('\n');
            (0, chai_1.expect)(normalize(raw)).to.equal(expected);
        });
        it('leaves single-line and already-flush descriptions untouched', () => {
            (0, chai_1.expect)(normalize('A short description.')).to.equal('A short description.');
            (0, chai_1.expect)(normalize('First line.\nSecond line.')).to.equal('First line.\nSecond line.');
        });
        it('ignores blank lines when computing the shared indentation', () => {
            (0, chai_1.expect)(normalize('Intro.\n\n    - item')).to.equal('Intro.\n\n- item');
        });
    });
    describe('set / reset', () => {
        it('writes to the mapped preference scope', () => {
            const { service, preferences } = createService({});
            return service.set('pref', 42, 'workspace').then(() => {
                (0, chai_1.expect)(preferences.sets).to.deep.equal([{ preferenceId: 'pref', value: 42, scope: common_1.PreferenceScope.Workspace, resourceUri: undefined }]);
            });
        });
        it('resets by writing `undefined` to the mapped scope', () => {
            const { service, preferences } = createService({});
            return service.reset('pref', 'user', 'file:///ws').then(() => {
                (0, chai_1.expect)(preferences.sets).to.deep.equal([{ preferenceId: 'pref', value: undefined, scope: common_1.PreferenceScope.User, resourceUri: 'file:///ws' }]);
            });
        });
    });
});
//# sourceMappingURL=ai-settings-row-service.spec.js.map