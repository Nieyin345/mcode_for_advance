"use strict";
// *****************************************************************************
// Copyright (C) 2018 Ericsson and others.
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
/* eslint-disable @typescript-eslint/no-explicit-any */
const jsdom_1 = require("../test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const assert = require("assert");
const inversify_1 = require("inversify");
const preferences_1 = require("../../common/preferences");
const preference_schema_1 = require("../../common/preferences/preference-schema");
const frontend_application_config_provider_1 = require("../frontend-application-config-provider");
const test_1 = require("./test");
const preference_proxy_1 = require("../../common/preferences/preference-proxy");
const frontend_application_bindings_1 = require("../frontend-application-bindings");
const logger_1 = require("../../common/logger");
const mock_logger_1 = require("../../common/test/mock-logger");
disableJSDOM();
process.on('unhandledRejection', (reason, promise) => {
    console.error(reason);
    throw reason;
});
const { expect } = require('chai');
let testContainer;
function createTestContainer() {
    const result = new inversify_1.Container();
    (0, frontend_application_bindings_1.bindPreferenceService)(result.bind.bind(result));
    (0, test_1.bindMockPreferenceProviders)(result.bind.bind(result), result.unbind.bind(result));
    result.bind(logger_1.ILogger).to(mock_logger_1.MockLogger);
    return result;
}
describe('Preference Service', () => {
    let prefService;
    let prefSchema;
    before(() => {
        disableJSDOM = (0, jsdom_1.enableJSDOM)();
        frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
    });
    after(() => {
        disableJSDOM();
    });
    beforeEach(async () => {
        testContainer = createTestContainer();
        prefSchema = testContainer.get(preference_schema_1.PreferenceSchemaService);
        prefService = testContainer.get(preferences_1.PreferenceService);
        getProvider(preferences_1.PreferenceScope.User).markReady();
        getProvider(preferences_1.PreferenceScope.Workspace).markReady();
        getProvider(preferences_1.PreferenceScope.Folder).markReady();
        console.log('before ready');
        try {
            await prefService.ready;
        }
        catch (e) {
            console.error(e);
        }
        console.log('done');
    });
    afterEach(() => {
    });
    function getProvider(scope) {
        return testContainer.getNamed(preferences_1.PreferenceProvider, scope);
    }
    it('should return the preference from the more specific scope (user > workspace)', () => {
        prefSchema.addSchema({
            scope: preferences_1.PreferenceScope.Folder,
            properties: {
                'test.number': {
                    type: 'number',
                }
            }
        });
        const userProvider = getProvider(preferences_1.PreferenceScope.User);
        const workspaceProvider = getProvider(preferences_1.PreferenceScope.Workspace);
        const folderProvider = getProvider(preferences_1.PreferenceScope.Folder);
        userProvider.setPreference('test.number', 1);
        expect(prefService.get('test.number')).equals(1);
        workspaceProvider.setPreference('test.number', 0);
        expect(prefService.get('test.number')).equals(0);
        folderProvider.setPreference('test.number', 2);
        expect(prefService.get('test.number')).equals(2);
        // remove property on lower scope
        folderProvider.setPreference('test.number', undefined);
        expect(prefService.get('test.number')).equals(0);
    });
    it('should throw a TypeError if the preference (reference object) is modified', () => {
        prefSchema.addSchema({
            scope: preferences_1.PreferenceScope.Folder,
            properties: {
                'test.immutable': {
                    type: 'array',
                    items: {
                        type: 'string'
                    },
                }
            }
        });
        const userProvider = getProvider(preferences_1.PreferenceScope.User);
        userProvider.setPreference('test.immutable', [
            'test', 'test', 'test'
        ]);
        const immutablePref = prefService.get('test.immutable');
        expect(immutablePref).to.not.be.undefined;
        if (immutablePref !== undefined) {
            expect(() => immutablePref.push('fails')).to.throw(TypeError);
        }
    });
    it('should still report the more specific preference even though the less specific one changed', () => {
        prefSchema.addSchema({
            scope: preferences_1.PreferenceScope.Folder,
            properties: {
                'test.number': {
                    type: 'number',
                }
            }
        });
        const userProvider = getProvider(preferences_1.PreferenceScope.User);
        const workspaceProvider = getProvider(preferences_1.PreferenceScope.Workspace);
        userProvider.setPreference('test.number', 1);
        workspaceProvider.setPreference('test.number', 0);
        expect(prefService.get('test.number')).equals(0);
        userProvider.setPreference('test.number', 4);
        expect(prefService.get('test.number')).equals(0);
    });
    it('should not fire events if preference schema is unset in the same tick ', async () => {
        const events = [];
        prefService.onPreferenceChanged(event => events.push(event));
        prefSchema.registerOverrideIdentifier('go');
        const toUnset = prefSchema.addSchema({
            scope: preferences_1.PreferenceScope.User,
            properties: {
                'editor.insertSpaces': {
                    type: 'boolean',
                    default: true,
                    overridable: true
                }
            }
        });
        prefSchema.registerOverride('editor.insertSpaces', 'go', false);
        assert.deepStrictEqual([], events.map(e => e.preferenceName), 'events after set in the same tick');
        assert.strictEqual(prefService.get('editor.insertSpaces'), true, 'get before');
        assert.strictEqual(prefService.get('[go].editor.insertSpaces'), false, 'get before overridden');
        toUnset.dispose();
        assert.deepStrictEqual([], events.map(e => e.preferenceName), 'events after unset in the same tick');
        assert.strictEqual(prefService.get('editor.insertSpaces'), undefined, 'get after'); // removing the schema does not removes the default value
        assert.strictEqual(prefService.get('[go].editor.insertSpaces'), false, 'get after overridden'); // but not the override
        assert.deepStrictEqual([], events.map(e => e.preferenceName), 'events in next tick');
    });
    it('should fire events if preference schema is unset in another tick', async () => {
        prefSchema.registerOverrideIdentifier('go');
        let pending = new Promise(resolve => prefService.onPreferencesChanged(resolve));
        const toUnset = prefSchema.addSchema({
            scope: preferences_1.PreferenceScope.User,
            properties: {
                'editor.insertSpaces': {
                    type: 'boolean',
                    default: true,
                    overridable: true
                }
            }
        });
        prefSchema.registerOverride('editor.insertSpaces', 'go', false);
        let changes = await pending;
        assert.deepStrictEqual([
            'editor.insertSpaces',
            '[go].editor.insertSpaces'
        ], Object.keys(changes).map(key => changes[key].preferenceName), 'events before');
        assert.strictEqual(prefService.get('editor.insertSpaces'), true, 'get before');
        assert.strictEqual(prefService.get('[go].editor.insertSpaces'), false, 'get before overridden');
        pending = new Promise(resolve => prefService.onPreferencesChanged(resolve));
        toUnset.dispose();
        changes = await pending;
        assert.deepStrictEqual([
            'editor.insertSpaces',
            '[go].editor.insertSpaces'
        ], Object.keys(changes).map(key => changes[key].preferenceName), 'events after');
        assert.strictEqual(prefService.get('editor.insertSpaces'), undefined, 'get after');
        assert.strictEqual(prefService.get('[go].editor.insertSpaces'), false, 'get after overridden');
    });
    function prepareServices(options) {
        prefSchema.addSchema(options && options.schema || {
            scope: preferences_1.PreferenceScope.User,
            properties: {
                'editor.tabSize': {
                    type: 'number',
                    default: 4,
                    description: '',
                    overridable: true,
                }
            }
        });
        return { preferences: prefService, schema: prefSchema };
    }
    describe('PreferenceService.updateValues()', () => {
        const TAB_SIZE = 'editor.tabSize';
        const DUMMY_URI = 'dummy_uri';
        async function generateAndCheckValues(preferences, globalValue, workspaceValue, workspaceFolderValue) {
            await preferences.set(TAB_SIZE, globalValue, preferences_1.PreferenceScope.User);
            await preferences.set(TAB_SIZE, workspaceValue, preferences_1.PreferenceScope.Workspace);
            await preferences.set(TAB_SIZE, workspaceFolderValue, preferences_1.PreferenceScope.Folder, DUMMY_URI);
            const expectedValue = workspaceFolderValue ?? workspaceValue ?? globalValue ?? 4;
            checkValues(preferences, globalValue, workspaceValue, workspaceFolderValue, expectedValue);
        }
        function checkValues(preferences, globalValue, workspaceValue, workspaceFolderValue, value = 4) {
            const expected = {
                preferenceName: 'editor.tabSize',
                defaultValue: 4,
                globalValue,
                workspaceValue,
                workspaceFolderValue,
                sessionValue: undefined,
                value,
            };
            const inspection = preferences.inspect(TAB_SIZE, DUMMY_URI);
            assert.deepStrictEqual(inspection, expected);
        }
        it('should modify the narrowest scope.', async () => {
            const { preferences } = prepareServices();
            await generateAndCheckValues(preferences, 1, 2, 3);
            await preferences.updateValue(TAB_SIZE, 8, DUMMY_URI);
            checkValues(preferences, 1, 2, 8, 8);
            await generateAndCheckValues(preferences, 1, 2, undefined);
            await preferences.updateValue(TAB_SIZE, 8, DUMMY_URI);
            checkValues(preferences, 1, 8, undefined, 8);
            await generateAndCheckValues(preferences, 1, undefined, undefined);
            await preferences.updateValue(TAB_SIZE, 8, DUMMY_URI);
            checkValues(preferences, 8, undefined, undefined, 8);
        });
        it('defaults to user scope.', async () => {
            const { preferences } = prepareServices();
            checkValues(preferences, undefined, undefined, undefined);
            await preferences.updateValue(TAB_SIZE, 8, DUMMY_URI);
            checkValues(preferences, 8, undefined, undefined, 8);
        });
        it('clears all settings when input is undefined.', async () => {
            const { preferences } = prepareServices();
            await generateAndCheckValues(preferences, 1, 2, 3);
            await preferences.updateValue(TAB_SIZE, undefined, DUMMY_URI);
            checkValues(preferences, undefined, undefined, undefined);
        });
        it('deletes user setting if user is only defined scope and target is default value', async () => {
            const { preferences } = prepareServices();
            await generateAndCheckValues(preferences, 8, undefined, undefined);
            await preferences.updateValue(TAB_SIZE, 4, DUMMY_URI);
            checkValues(preferences, undefined, undefined, undefined);
        });
        it('does not delete setting in lower scopes, even if target is default', async () => {
            const { preferences } = prepareServices();
            await generateAndCheckValues(preferences, undefined, 2, undefined);
            await preferences.updateValue(TAB_SIZE, 4, DUMMY_URI);
            checkValues(preferences, undefined, 4, undefined);
        });
    });
    describe('overridden preferences', () => {
        it('get #0', () => {
            const { preferences } = prepareServices();
            preferences.set('[json].editor.tabSize', 2, preferences_1.PreferenceScope.User);
            expect(preferences.get('editor.tabSize')).to.equal(4);
            expect(preferences.get('[json].editor.tabSize')).to.equal(2);
        });
        it('get #1', () => {
            const { preferences, schema } = prepareServices();
            schema.registerOverrideIdentifier('json');
            expect(preferences.get('editor.tabSize')).to.equal(4);
            expect(preferences.get('[json].editor.tabSize')).to.equal(4);
            preferences.set('[json].editor.tabSize', 2, preferences_1.PreferenceScope.User);
            expect(preferences.get('editor.tabSize')).to.equal(4);
            expect(preferences.get('[json].editor.tabSize')).to.equal(2);
        });
        it('get #2', () => {
            const { preferences, schema } = prepareServices();
            schema.registerOverrideIdentifier('json');
            expect(preferences.get('editor.tabSize')).to.equal(4);
            expect(preferences.get('[json].editor.tabSize')).to.equal(4);
            preferences.set('editor.tabSize', 2, preferences_1.PreferenceScope.User);
            expect(preferences.get('editor.tabSize')).to.equal(2);
            expect(preferences.get('[json].editor.tabSize')).to.equal(2);
        });
        it('has', () => {
            const { preferences, schema } = prepareServices();
            expect(preferences.has('editor.tabSize')).to.be.true;
            expect(preferences.has('[json].editor.tabSize')).to.be.false;
            schema.registerOverrideIdentifier('json');
            expect(preferences.has('editor.tabSize')).to.be.true;
            expect(preferences.has('[json].editor.tabSize')).to.be.true;
        });
        it('inspect #0', () => {
            const { preferences, schema } = prepareServices();
            const expected = {
                preferenceName: 'editor.tabSize',
                defaultValue: 4,
                globalValue: undefined,
                workspaceValue: undefined,
                workspaceFolderValue: undefined,
                sessionValue: undefined,
                value: 4,
            };
            assert.deepStrictEqual(expected, preferences.inspect('editor.tabSize'));
            assert.ok(!preferences.has('[json].editor.tabSize'));
            schema.registerOverrideIdentifier('json');
            assert.deepStrictEqual(expected, preferences.inspect('editor.tabSize'));
            assert.deepStrictEqual({
                ...expected,
                preferenceName: '[json].editor.tabSize'
            }, preferences.inspect('[json].editor.tabSize'));
        });
        it('inspect #1', () => {
            const { preferences, schema } = prepareServices();
            const expected = {
                preferenceName: 'editor.tabSize',
                defaultValue: 4,
                globalValue: 2,
                workspaceValue: undefined,
                workspaceFolderValue: undefined,
                sessionValue: undefined,
                value: 2
            };
            preferences.set('editor.tabSize', 2, preferences_1.PreferenceScope.User);
            assert.deepStrictEqual(expected, preferences.inspect('editor.tabSize'));
            assert.ok(!preferences.has('[json].editor.tabSize'));
            schema.registerOverrideIdentifier('json');
            assert.deepStrictEqual(expected, preferences.inspect('editor.tabSize'));
            assert.deepStrictEqual({
                ...expected,
                preferenceName: '[json].editor.tabSize'
            }, preferences.inspect('[json].editor.tabSize'));
        });
        it('inspect #2', () => {
            const { preferences, schema } = prepareServices();
            const expected = {
                preferenceName: 'editor.tabSize',
                defaultValue: 4,
                globalValue: undefined,
                workspaceValue: undefined,
                workspaceFolderValue: undefined,
                sessionValue: undefined,
                value: 4
            };
            assert.deepStrictEqual(expected, preferences.inspect('editor.tabSize'));
            assert.ok(!preferences.has('[json].editor.tabSize'));
            schema.registerOverrideIdentifier('json');
            preferences.set('[json].editor.tabSize', 2, preferences_1.PreferenceScope.User);
            assert.deepStrictEqual(expected, preferences.inspect('editor.tabSize'));
            assert.deepStrictEqual({
                ...expected,
                preferenceName: '[json].editor.tabSize',
                globalValue: 2,
                value: 2,
            }, preferences.inspect('[json].editor.tabSize'));
        });
        it('onPreferenceChanged #0', async () => {
            const { preferences, schema } = prepareServices();
            const events = [];
            preferences.onPreferenceChanged(event => events.push(event));
            schema.registerOverrideIdentifier('json');
            preferences.set('[json].editor.tabSize', 2, preferences_1.PreferenceScope.User);
            await preferences.set('editor.tabSize', 3, preferences_1.PreferenceScope.User);
            assert.deepStrictEqual([
                '[json].editor.tabSize',
                'editor.tabSize'
            ], events.map(e => e.preferenceName));
        });
        it('onPreferenceChanged #1', async () => {
            const { preferences, schema } = prepareServices();
            const events = [];
            preferences.onPreferenceChanged(event => events.push(event));
            schema.registerOverrideIdentifier('json');
            await preferences.set('editor.tabSize', 2, preferences_1.PreferenceScope.User);
            assert.deepStrictEqual([
                'editor.tabSize',
                '[json].editor.tabSize'
            ], events.map(e => e.preferenceName));
        });
        it('onPreferenceChanged #2', async function () {
            const { preferences, schema } = prepareServices();
            schema.registerOverrideIdentifier('json');
            schema.registerOverrideIdentifier('javascript');
            preferences.set('[json].editor.tabSize', 2, preferences_1.PreferenceScope.User);
            await preferences.set('editor.tabSize', 3, preferences_1.PreferenceScope.User);
            const events = [];
            const proxy = (0, preference_proxy_1.createPreferenceProxy)(preferences, schema.getJSONSchema(preferences_1.PreferenceScope.Folder), { overrideIdentifier: 'json' });
            proxy.onPreferenceChanged(event => events.push(event));
            await preferences.set('[javascript].editor.tabSize', 4, preferences_1.PreferenceScope.User);
            assert.deepStrictEqual([], events.map(e => e.preferenceName), 'changes not relevant to json override should be ignored');
        });
        it('onPreferenceChanged #3', async () => {
            const { preferences, schema } = prepareServices();
            schema.registerOverrideIdentifier('json');
            preferences.set('[json].editor.tabSize', 2, preferences_1.PreferenceScope.User);
            await preferences.set('editor.tabSize', 3, preferences_1.PreferenceScope.User);
            const events = [];
            preferences.onPreferenceChanged(event => events.push(event));
            await preferences.set('[json].editor.tabSize', undefined, preferences_1.PreferenceScope.User);
            assert.deepStrictEqual(['[json].editor.tabSize'], events.map(e => e.preferenceName));
        });
        it('defaultOverrides [go].editor.formatOnSave', () => {
            const { preferences, schema } = prepareServices({
                schema: {
                    scope: preferences_1.PreferenceScope.Folder,
                    properties: {
                        'editor.insertSpaces': {
                            type: 'boolean',
                            default: true,
                            overridable: true
                        },
                        'editor.formatOnSave': {
                            type: 'boolean',
                            default: false,
                            overridable: true
                        }
                    }
                }
            });
            assert.strictEqual(true, preferences.get('editor.insertSpaces'));
            assert.strictEqual(undefined, preferences.get('[go].editor.insertSpaces'));
            assert.strictEqual(false, preferences.get('editor.formatOnSave'));
            assert.strictEqual(undefined, preferences.get('[go].editor.formatOnSave'));
            schema.registerOverrideIdentifier('go');
            prefSchema.registerOverride('editor.insertSpaces', 'go', false);
            prefSchema.registerOverride('editor.formatOnSave', 'go', true);
            assert.strictEqual(true, preferences.get('editor.insertSpaces'));
            assert.strictEqual(false, preferences.get('[go].editor.insertSpaces'));
            assert.strictEqual(false, preferences.get('editor.formatOnSave'));
            assert.strictEqual(true, preferences.get('[go].editor.formatOnSave'));
        });
    });
    describe('session-scope overrides', () => {
        function getSessionProvider() {
            return testContainer.getNamed(preferences_1.PreferenceProvider, preferences_1.PreferenceScope.Session);
        }
        beforeEach(() => {
            prefSchema.addSchema({
                scope: preferences_1.PreferenceScope.Folder,
                properties: {
                    'test.session': { type: 'number' }
                }
            });
        });
        it('takes precedence over the user scope', async () => {
            getProvider(preferences_1.PreferenceScope.User).setPreference('test.session', 1);
            await prefService.set('test.session', 99, preferences_1.PreferenceScope.Session);
            expect(prefService.get('test.session')).equals(99);
        });
        it('is dropped when the same key is written to a persistent scope', async () => {
            const sessionProvider = getSessionProvider();
            getProvider(preferences_1.PreferenceScope.User).setPreference('test.session', 1);
            await prefService.set('test.session', 99, preferences_1.PreferenceScope.Session);
            expect(prefService.get('test.session')).equals(99);
            // An explicit user edit must win over the session override and clear it.
            await prefService.set('test.session', 2, preferences_1.PreferenceScope.User);
            expect(sessionProvider.get('test.session')).to.equal(undefined);
            expect(prefService.get('test.session')).equals(2);
        });
        it('is reported via inspect().sessionValue', async () => {
            await prefService.set('test.session', 42, preferences_1.PreferenceScope.Session);
            expect(prefService.inspect('test.session')?.sessionValue).equals(42);
        });
        it('emits a Session-scope change event when evicted by a persistent write', async () => {
            // Status bar listeners rely on this: an eviction must surface as an
            // onPreferenceChanged event whose `scope` is Session, otherwise the
            // status bar would never clear after the override is dropped.
            await prefService.set('test.session', 99, preferences_1.PreferenceScope.Session);
            const sessionScopeEvents = [];
            const listener = prefService.onPreferenceChanged(e => {
                if (e.preferenceName === 'test.session') {
                    sessionScopeEvents.push(e.scope);
                }
            });
            try {
                await prefService.set('test.session', 2, preferences_1.PreferenceScope.User);
            }
            finally {
                listener.dispose();
            }
            expect(sessionScopeEvents).to.include(preferences_1.PreferenceScope.Session);
        });
        it('is left alone when writing to the Session scope itself', async () => {
            const sessionProvider = getSessionProvider();
            await prefService.set('test.session', 7, preferences_1.PreferenceScope.Session);
            expect(sessionProvider.get('test.session')).to.equal(7);
            // A second write to Session must not trigger eviction of itself.
            await prefService.set('test.session', 8, preferences_1.PreferenceScope.Session);
            expect(sessionProvider.get('test.session')).to.equal(8);
        });
    });
});
//# sourceMappingURL=preference-service.spec.js.map