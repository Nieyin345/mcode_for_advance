"use strict";
// *****************************************************************************
// Copyright (C) 2017 Ericsson and others.
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
const tslib_1 = require("tslib");
const jsdom_1 = require("./test/jsdom");
let disableJSDOM = (0, jsdom_1.enableJSDOM)();
const frontend_application_config_provider_1 = require("./frontend-application-config-provider");
frontend_application_config_provider_1.FrontendApplicationConfigProvider.set({});
const inversify_1 = require("inversify");
const contribution_provider_1 = require("../common/contribution-provider");
const keyboard_layout_provider_1 = require("../common/keyboard/keyboard-layout-provider");
const logger_1 = require("../common/logger");
const keybinding_1 = require("./keybinding");
const keys_1 = require("./keyboard/keys");
const keyboard_layout_service_1 = require("./keyboard/keyboard-layout-service");
const command_1 = require("../common/command");
const label_parser_1 = require("./label-parser");
const mock_logger_1 = require("../common/test/mock-logger");
const frontend_application_state_1 = require("./frontend-application-state");
const context_key_service_1 = require("./context-key-service");
const core_preferences_1 = require("../common/core-preferences");
const os = require("../common/os");
const chai = require("chai");
const sinon = require("sinon");
const event_1 = require("../common/event");
const frontend_application_bindings_1 = require("./frontend-application-bindings");
const markdown_renderer_1 = require("./markdown-rendering/markdown-renderer");
const status_bar_1 = require("./status-bar");
disableJSDOM();
const expect = chai.expect;
let keybindingRegistry;
let commandRegistry;
let testContainer;
let stub;
before(async () => {
    disableJSDOM = (0, jsdom_1.enableJSDOM)();
    testContainer = new inversify_1.Container();
    const module = new inversify_1.ContainerModule((bind, unbind, isBound, rebind) => {
        /* Mock logger binding*/
        bind(logger_1.ILogger).to(mock_logger_1.MockLogger);
        bind(keyboard_layout_service_1.KeyboardLayoutService).toSelf().inSingletonScope();
        bind(MockKeyboardLayoutProvider).toSelf().inSingletonScope();
        bind(keyboard_layout_provider_1.KeyboardLayoutProvider).toService(MockKeyboardLayoutProvider);
        bind(MockKeyboardLayoutChangeNotifier).toSelf().inSingletonScope();
        bind(keyboard_layout_provider_1.KeyboardLayoutChangeNotifier).toService(MockKeyboardLayoutChangeNotifier);
        (0, contribution_provider_1.bindContributionProvider)(bind, keybinding_1.KeybindingContext);
        bind(command_1.CommandRegistry).toSelf().inSingletonScope();
        (0, contribution_provider_1.bindContributionProvider)(bind, command_1.CommandContribution);
        bind(keybinding_1.KeybindingRegistry).toSelf();
        (0, contribution_provider_1.bindContributionProvider)(bind, keybinding_1.KeybindingContribution);
        bind(TestContribution).toSelf().inSingletonScope();
        [command_1.CommandContribution, keybinding_1.KeybindingContribution].forEach(serviceIdentifier => bind(serviceIdentifier).toService(TestContribution));
        bind(keybinding_1.KeybindingContext).toConstantValue({
            id: 'testContext',
            isEnabled(arg) {
                return true;
            }
        });
        bind(status_bar_1.StatusBar).toConstantValue({});
        bind(markdown_renderer_1.MarkdownRendererImpl).toSelf().inSingletonScope();
        bind(markdown_renderer_1.MarkdownRenderer).toService(markdown_renderer_1.MarkdownRendererImpl);
        bind(markdown_renderer_1.MarkdownRendererFactory).toFactory(({ container }) => () => container.get(markdown_renderer_1.MarkdownRenderer));
        bind(command_1.CommandService).toService(command_1.CommandRegistry);
        bind(label_parser_1.LabelParser).toSelf().inSingletonScope();
        bind(context_key_service_1.ContextKeyService).to(MockContextKeyService).inSingletonScope();
        bind(frontend_application_state_1.FrontendApplicationStateService).toSelf().inSingletonScope();
        bind(core_preferences_1.CorePreferences).toConstantValue({});
        (0, frontend_application_bindings_1.bindPreferenceService)(bind);
    });
    testContainer.load(module);
    commandRegistry = testContainer.get(command_1.CommandRegistry);
    commandRegistry.onStart();
});
after(() => {
    disableJSDOM();
});
beforeEach(async () => {
    stub = sinon.stub(os, 'isOSX').value(false);
    keybindingRegistry = testContainer.get(keybinding_1.KeybindingRegistry);
    await keybindingRegistry.onStart();
});
afterEach(() => {
    stub.restore();
});
describe('keybindings', () => {
    it('should register the default keybindings', () => {
        const keybinding = keybindingRegistry.getKeybindingsForCommand(TEST_COMMAND.id);
        expect(keybinding).is.not.undefined;
        const keybinding2 = keybindingRegistry.getKeybindingsForCommand('undefined.command');
        expect(keybinding2.length).is.equal(0);
    });
    it('should set a keymap', () => {
        const keybindings = [{
                command: TEST_COMMAND.id,
                keybinding: 'ctrl+c'
            }];
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, keybindings);
        const bindings = keybindingRegistry.getKeybindingsForCommand(TEST_COMMAND.id);
        if (bindings) {
            const keyCode = keys_1.KeyCode.parse(bindings[0].keybinding);
            expect(keyCode.key).to.be.equal(keys_1.Key.KEY_C);
            expect(keyCode.ctrl).to.be.true;
        }
    });
    it('should reset to default in case of invalid keybinding', () => {
        const keybindings = [{
                command: TEST_COMMAND.id,
                keybinding: 'ctrl+invalid'
            }];
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, keybindings);
        const bindings = keybindingRegistry.getKeybindingsForCommand(TEST_COMMAND.id);
        if (bindings) {
            const keyCode = keys_1.KeyCode.parse(bindings[0].keybinding);
            expect(keyCode.key).to.be.equal(keys_1.Key.KEY_A);
            expect(keyCode.ctrl).to.be.true;
        }
    });
    it('should remove all disabled keybindings from a command that has multiple keybindings', () => {
        const keybindings = [{
                command: TEST_COMMAND2.id,
                keybinding: 'F3'
            },
            {
                command: '-' + TEST_COMMAND2.id,
                context: 'testContext',
                keybinding: 'ctrl+f1'
            },
        ];
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, keybindings);
        const bindings = keybindingRegistry.getKeybindingsForCommand(TEST_COMMAND2.id);
        if (bindings) {
            // a USER one and a DEFAULT one
            expect(bindings.length).to.be.equal(2);
            const keyCode = keys_1.KeyCode.parse(bindings[0].keybinding);
            expect(keyCode.key).to.be.equal(keys_1.Key.F3);
            expect(keyCode.ctrl).to.be.false;
            const keyCode2 = keys_1.KeyCode.parse(bindings[1].keybinding);
            expect(keyCode2.key).to.be.equal(keys_1.Key.F2);
            expect(keyCode2.ctrl).to.be.true;
        }
    });
    it('should register a keybinding', () => {
        const keybinding = {
            command: TEST_COMMAND2.id,
            keybinding: 'F5'
        };
        expect(isKeyBindingRegistered(keybinding)).to.be.false;
        keybindingRegistry.registerKeybinding(keybinding);
        expect(isKeyBindingRegistered(keybinding)).to.be.true;
    });
    it('should unregister all keybindings from a specific command', () => {
        const otherKeybinding = {
            command: TEST_COMMAND.id,
            keybinding: 'F4'
        };
        keybindingRegistry.registerKeybinding(otherKeybinding);
        expect(isKeyBindingRegistered(otherKeybinding)).to.be.true;
        const keybinding = {
            command: TEST_COMMAND2.id,
            keybinding: 'F5'
        };
        const keybinding2 = {
            command: TEST_COMMAND2.id,
            keybinding: 'F6'
        };
        keybindingRegistry.registerKeybinding(keybinding);
        keybindingRegistry.registerKeybinding(keybinding2);
        expect(isKeyBindingRegistered(keybinding)).to.be.true;
        expect(isKeyBindingRegistered(keybinding2)).to.be.true;
        keybindingRegistry.unregisterKeybinding(TEST_COMMAND2);
        expect(isKeyBindingRegistered(keybinding)).to.be.false;
        expect(isKeyBindingRegistered(keybinding2)).to.be.false;
        const bindingsAfterUnregister = keybindingRegistry.getKeybindingsForCommand(TEST_COMMAND2.id);
        expect(bindingsAfterUnregister).not.to.be.undefined;
        expect(bindingsAfterUnregister.length).to.be.equal(0);
        expect(isKeyBindingRegistered(otherKeybinding)).to.be.true;
    });
    it('should unregister a specific keybinding', () => {
        const otherKeybinding = {
            command: TEST_COMMAND2.id,
            keybinding: 'F4'
        };
        keybindingRegistry.registerKeybinding(otherKeybinding);
        const keybinding = {
            command: TEST_COMMAND2.id,
            keybinding: 'F5'
        };
        keybindingRegistry.registerKeybinding(keybinding);
        expect(isKeyBindingRegistered(otherKeybinding)).to.be.true;
        expect(isKeyBindingRegistered(keybinding)).to.be.true;
        keybindingRegistry.unregisterKeybinding(keybinding);
        expect(isKeyBindingRegistered(keybinding)).to.be.false;
        expect(isKeyBindingRegistered(otherKeybinding)).to.be.true;
    });
    it('should unregister a specific key', () => {
        const otherKeybinding = {
            command: TEST_COMMAND.id,
            keybinding: 'F4'
        };
        keybindingRegistry.registerKeybinding(otherKeybinding);
        const testKey = 'F5';
        const keybinding = {
            command: TEST_COMMAND2.id,
            keybinding: testKey
        };
        const keybinding2 = {
            command: TEST_COMMAND.id,
            keybinding: testKey
        };
        keybindingRegistry.registerKeybinding(keybinding);
        keybindingRegistry.registerKeybinding(keybinding2);
        expect(isKeyBindingRegistered(otherKeybinding)).to.be.true;
        expect(isKeyBindingRegistered(keybinding)).to.be.true;
        expect(isKeyBindingRegistered(keybinding2)).to.be.true;
        keybindingRegistry.unregisterKeybinding(testKey);
        expect(isKeyBindingRegistered(otherKeybinding)).to.be.true;
        expect(isKeyBindingRegistered(keybinding)).to.be.false;
        expect(isKeyBindingRegistered(keybinding2)).to.be.false;
    });
    it('should register a correct keybinding, then default back to the original for a wrong one after', () => {
        let keybindings = [{
                command: TEST_COMMAND.id,
                keybinding: 'ctrl+c'
            }];
        // Get default binding
        const keystroke = keybindingRegistry.getKeybindingsForCommand(TEST_COMMAND.id);
        // Set correct new binding
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, keybindings);
        const bindings = keybindingRegistry.getKeybindingsForCommand(TEST_COMMAND.id);
        if (bindings) {
            const keyCode = keys_1.KeyCode.parse(bindings[0].keybinding);
            expect(keyCode.key).to.be.equal(keys_1.Key.KEY_C);
            expect(keyCode.ctrl).to.be.true;
        }
        // Set invalid binding
        keybindings = [{
                command: TEST_COMMAND.id,
                keybinding: 'ControlLeft+Invalid'
            }];
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, keybindings);
        const defaultBindings = keybindingRegistry.getKeybindingsForCommand(TEST_COMMAND.id);
        if (defaultBindings) {
            if (keystroke) {
                const keyCode = keys_1.KeyCode.parse(defaultBindings[0].keybinding);
                const keyStrokeCode = keys_1.KeyCode.parse(keystroke[0].keybinding);
                expect(keyCode.key).to.be.equal(keyStrokeCode.key);
            }
        }
    });
    it('should only return the more specific keybindings when a keystroke is entered', () => {
        const keybindingsUser = [{
                command: TEST_COMMAND.id,
                keybinding: 'ctrl+b'
            }];
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, keybindingsUser);
        const keybindingsSpecific = [{
                command: TEST_COMMAND.id,
                keybinding: 'ctrl+c'
            }];
        const validKeyCode = keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_C, modifiers: [keys_1.KeyModifier.CtrlCmd] });
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.WORKSPACE, keybindingsSpecific);
        let match = keybindingRegistry.matchKeybinding([keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.CtrlCmd] })]);
        expect(match && match.kind).to.be.equal('full');
        match = keybindingRegistry.matchKeybinding([keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_B, modifiers: [keys_1.KeyModifier.CtrlCmd] })]);
        expect(match && match.kind).to.be.equal('full');
        match = keybindingRegistry.matchKeybinding([keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_C, modifiers: [keys_1.KeyModifier.CtrlCmd] })]);
        const keyCode = match && keys_1.KeyCode.parse(match.binding.keybinding);
        expect(keyCode?.key).to.be.equal(validKeyCode.key);
    });
    it('should return partial keybinding matches', () => {
        const keybindingsUser = [{
                command: TEST_COMMAND.id,
                keybinding: 'ctrlcmd+x t'
            }];
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, keybindingsUser);
        const validKeyCodes = [];
        validKeyCodes.push(keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_C, modifiers: [keys_1.KeyModifier.CtrlCmd] }));
        validKeyCodes.push(keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_T }));
        const match = keybindingRegistry.matchKeybinding(keys_1.KeySequence.parse('ctrlcmd+x'));
        expect(match && match.kind).to.be.equal('partial');
    });
    it('should possible to override keybinding', () => {
        const overriddenKeybinding = 'ctrlcmd+b a';
        const command = TEST_COMMAND_SHADOW.id;
        const keybindingShadowing = [
            {
                command,
                keybinding: overriddenKeybinding
            },
            {
                command,
                keybinding: 'ctrlcmd+b'
            }
        ];
        keybindingRegistry.registerKeybindings(...keybindingShadowing);
        const bindings = keybindingRegistry.getKeybindingsForCommand(command);
        expect(bindings.length).to.be.equal(2);
        expect(bindings[0].keybinding).to.be.equal('ctrlcmd+b');
        expect(bindings[1].keybinding).to.be.equal(overriddenKeybinding);
    });
    it('overridden bindings should be returned last', () => {
        const keyCode = keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.Shift] });
        const overriddenDefaultBinding = {
            keybinding: keyCode.toString(),
            command: 'test.overridden-default-command'
        };
        const defaultBinding = {
            keybinding: keyCode.toString(),
            command: 'test.default-command'
        };
        const userBinding = {
            keybinding: keyCode.toString(),
            command: 'test.user-command'
        };
        const workspaceBinding = {
            keybinding: keyCode.toString(),
            command: 'test.workspace-command'
        };
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.DEFAULT, [overriddenDefaultBinding, defaultBinding]);
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, [userBinding]);
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.WORKSPACE, [workspaceBinding]);
        // now WORKSPACE bindings are overriding the other scopes
        let match = keybindingRegistry.matchKeybinding([keyCode]);
        expect(match?.kind).to.be.equal('full');
        expect(match?.binding?.command).to.be.equal(workspaceBinding.command);
        keybindingRegistry.resetKeybindingsForScope(keybinding_1.KeybindingScope.WORKSPACE);
        // now it should find USER bindings
        match = keybindingRegistry.matchKeybinding([keyCode]);
        expect(match?.kind).to.be.equal('full');
        expect(match?.binding?.command).to.be.equal(userBinding.command);
        keybindingRegistry.resetKeybindingsForScope(keybinding_1.KeybindingScope.USER);
        // and finally it should fallback to DEFAULT bindings.
        match = keybindingRegistry.matchKeybinding([keyCode]);
        expect(match?.kind).to.be.equal('full');
        expect(match?.binding?.command).to.be.equal(defaultBinding.command);
        keybindingRegistry.resetKeybindingsForScope(keybinding_1.KeybindingScope.DEFAULT);
        // now the registry should be empty
        match = keybindingRegistry.matchKeybinding([keyCode]);
        expect(match).to.be.undefined;
    });
    it('should not match disabled keybindings', () => {
        const keyCode = keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.Shift] });
        const defaultBinding = {
            keybinding: keyCode.toString(),
            command: 'test.workspace-command'
        };
        const disableDefaultBinding = {
            keybinding: keyCode.toString(),
            command: '-test.workspace-command'
        };
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.DEFAULT, [defaultBinding]);
        let match = keybindingRegistry.matchKeybinding([keyCode]);
        expect(match?.kind).to.be.equal('full');
        expect(match?.binding?.command).to.be.equal(defaultBinding.command);
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.USER, [disableDefaultBinding]);
        match = keybindingRegistry.matchKeybinding([keyCode]);
        expect(match).to.be.undefined;
        keybindingRegistry.resetKeybindingsForScope(keybinding_1.KeybindingScope.USER);
        match = keybindingRegistry.matchKeybinding([keyCode]);
        expect(match?.kind).to.be.equal('full');
        expect(match?.binding?.command).to.be.equal(defaultBinding.command);
    });
    it('should prioritize bindings that use local context keys', () => {
        // Ensure JSDOM is enabled for this test since it uses document
        const disable = (0, jsdom_1.enableJSDOM)();
        const keyCode = keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_A, modifiers: [keys_1.KeyModifier.Shift] });
        // Register two commands with the same keybinding but different when clauses
        const globalBinding = {
            keybinding: keyCode.toString(),
            command: 'test.global-command',
            when: 'globalContextKey'
        };
        const localBinding = {
            keybinding: keyCode.toString(),
            command: 'test.local-command',
            when: 'localContextKey'
        };
        // Register commands with handlers so they are enabled
        commandRegistry.registerCommand({ id: 'test.global-command' }, { execute: () => { } });
        commandRegistry.registerCommand({ id: 'test.local-command' }, { execute: () => { } });
        // globalBinding is registered first, so without local context prioritization it would win
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.DEFAULT, [globalBinding, localBinding]);
        // Get the mock context key service
        const contextKeyService = testContainer.get(context_key_service_1.ContextKeyService);
        // Set up mock to return 'localContextKey' as a local key
        contextKeyService.setLocalContextKeys(new Set(['localContextKey']));
        // Both when clauses should match
        contextKeyService.setMatchResult(true);
        // Create a mock keyboard event with a target element
        const targetElement = document.createElement('div');
        const mockEvent = new KeyboardEvent('keydown', {
            key: 'A',
            shiftKey: true
        });
        Object.defineProperty(mockEvent, 'target', { value: targetElement });
        const match = keybindingRegistry.matchKeybinding([keyCode], mockEvent);
        // The localBinding should be selected because it uses a local context key
        expect(match?.kind).to.be.equal('full');
        expect(match?.binding?.command).to.be.equal('test.local-command');
        disable();
    });
    it('should fall back to first binding when no local context keys exist', () => {
        // Ensure JSDOM is enabled for this test since it uses document
        const disable = (0, jsdom_1.enableJSDOM)();
        const keyCode = keys_1.KeyCode.createKeyCode({ first: keys_1.Key.KEY_B, modifiers: [keys_1.KeyModifier.Shift] });
        const firstBinding = {
            keybinding: keyCode.toString(),
            command: 'test.first-command',
            when: 'someContextKey'
        };
        const secondBinding = {
            keybinding: keyCode.toString(),
            command: 'test.second-command',
            when: 'otherContextKey'
        };
        commandRegistry.registerCommand({ id: 'test.first-command' }, { execute: () => { } });
        commandRegistry.registerCommand({ id: 'test.second-command' }, { execute: () => { } });
        // Note: bindings registered later (later in the array) have higher priority
        // because insertBindingIntoScope inserts them at the front of the scope's keymap
        keybindingRegistry.setKeymap(keybinding_1.KeybindingScope.DEFAULT, [firstBinding, secondBinding]);
        const contextKeyService = testContainer.get(context_key_service_1.ContextKeyService);
        // No local context keys
        contextKeyService.setLocalContextKeys(new Set());
        contextKeyService.setMatchResult(true);
        const targetElement = document.createElement('div');
        const mockEvent = new KeyboardEvent('keydown', {
            key: 'B',
            shiftKey: true
        });
        Object.defineProperty(mockEvent, 'target', { value: targetElement });
        const match = keybindingRegistry.matchKeybinding([keyCode], mockEvent);
        // Should fall back to first enabled binding in priority order (secondBinding was registered later, so it wins)
        expect(match?.kind).to.be.equal('full');
        expect(match?.binding?.command).to.be.equal('test.second-command');
        disable();
    });
});
describe('acceleratorForKeyCode', () => {
    const ctrlV = keys_1.KeyCode.createKeyCode({ key: keys_1.Key.KEY_V, ctrl: true });
    const metaV = keys_1.KeyCode.createKeyCode({ key: keys_1.Key.KEY_V, meta: true });
    it('uses ASCII names with the separator on non-macOS', () => {
        stub.value(false);
        const accelerator = keybindingRegistry.acceleratorForKeyCode(ctrlV, '+');
        expect(accelerator).to.equal('Ctrl+V');
    });
    it('uses macOS symbols without a separator on macOS browser', () => {
        stub.value(true);
        const accelerator = keybindingRegistry.acceleratorForKeyCode(metaV, '+');
        expect(accelerator).to.equal('⌘V');
    });
    it('uses ASCII names with the separator on macOS Electron (asciiOnly)', () => {
        stub.value(true);
        const accelerator = keybindingRegistry.acceleratorForKeyCode(metaV, '+', true);
        expect(accelerator).to.equal('Cmd+V');
    });
});
const TEST_COMMAND = {
    id: 'test.command'
};
const TEST_COMMAND2 = {
    id: 'test.command2'
};
const TEST_COMMAND_SHADOW = {
    id: 'test.command-shadow'
};
let MockContextKeyService = class MockContextKeyService extends context_key_service_1.ContextKeyServiceDummyImpl {
    constructor() {
        super();
        this.localKeys = new Set();
        this.shouldMatch = true;
        this.parsedKeys = new Map();
        // Set up default parsed keys for test expressions
        this.parsedKeys.set('globalContextKey', new Set(['globalContextKey']));
        this.parsedKeys.set('localContextKey', new Set(['localContextKey']));
        this.parsedKeys.set('someContextKey', new Set(['someContextKey']));
        this.parsedKeys.set('otherContextKey', new Set(['otherContextKey']));
    }
    setLocalContextKeys(keys) {
        this.localKeys = keys;
    }
    setMatchResult(result) {
        this.shouldMatch = result;
    }
    match(expression, context) {
        return this.shouldMatch;
    }
    parseKeys(expression) {
        return this.parsedKeys.get(expression) || new Set([expression]);
    }
    getLocalContextKeys(element) {
        return this.localKeys;
    }
    createOverlay(overlay) {
        return this;
    }
};
MockContextKeyService = tslib_1.__decorate([
    (0, inversify_1.injectable)(),
    tslib_1.__metadata("design:paramtypes", [])
], MockContextKeyService);
let MockKeyboardLayoutProvider = class MockKeyboardLayoutProvider {
    getNativeLayout() {
        return Promise.resolve({
            info: { id: 'mock', lang: 'en' },
            mapping: {}
        });
    }
};
MockKeyboardLayoutProvider = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MockKeyboardLayoutProvider);
let MockKeyboardLayoutChangeNotifier = class MockKeyboardLayoutChangeNotifier {
    constructor() {
        this.emitter = new event_1.Emitter();
    }
    get onDidChangeNativeLayout() {
        return this.emitter.event;
    }
};
MockKeyboardLayoutChangeNotifier = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], MockKeyboardLayoutChangeNotifier);
let TestContribution = class TestContribution {
    registerCommands(commands) {
        commands.registerCommand(TEST_COMMAND);
        commands.registerCommand(TEST_COMMAND2);
        commands.registerCommand(TEST_COMMAND_SHADOW);
    }
    registerKeybindings(keybindings) {
        [{
                command: TEST_COMMAND.id,
                context: 'testContext',
                keybinding: 'ctrl+a'
            },
            {
                command: TEST_COMMAND2.id,
                context: 'testContext',
                keybinding: 'ctrl+f1'
            },
            {
                command: TEST_COMMAND2.id,
                context: 'testContext',
                keybinding: 'ctrl+f2'
            },
        ].forEach(binding => {
            keybindings.registerKeybinding(binding);
        });
    }
};
TestContribution = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], TestContribution);
function isKeyBindingRegistered(keybinding) {
    const bindings = keybindingRegistry.getKeybindingsForCommand(keybinding.command);
    expect(bindings).not.to.be.undefined;
    let keyBindingFound = false;
    bindings.forEach((value) => {
        if (value.command === keybinding.command && value.keybinding === keybinding.keybinding) {
            keyBindingFound = true;
        }
    });
    return keyBindingFound;
}
//# sourceMappingURL=keybinding.spec.js.map