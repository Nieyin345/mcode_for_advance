"use strict";
// *****************************************************************************
// Copyright (C) 2017 TypeFox and others.
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
const chai = require("chai");
const common_1 = require("../../common");
const expect = chai.expect;
class TestMenuNodeFactory {
    createGroup(id, orderString, when) {
        return new common_1.GroupImpl(id, orderString, when);
    }
    createSubmenu(id, label, contextKeyOverlays, orderString, icon, when) {
        return new common_1.SubmenuImpl(id, label, contextKeyOverlays, orderString, icon, when);
    }
    createSubmenuLink(delegate, sortString, when) {
        return new common_1.SubMenuLink(delegate, sortString, when);
    }
    createCommandMenu(item) {
        return {
            isVisible: () => true,
            isEnabled: () => true,
            isToggled: () => false,
            id: item.commandId,
            label: item.label || '',
            sortString: item.order || '',
            run: () => Promise.resolve()
        };
    }
}
describe('menu-model-registry', () => {
    describe('01 #register', () => {
        it('Should allow to register menu actions.', () => {
            const fileMenu = ['main', 'File'];
            const fileOpenMenu = [...fileMenu, '0_open'];
            const service = createMenuRegistry({
                registerMenus(menuRegistry) {
                    menuRegistry.registerSubmenu(fileMenu, 'File');
                    menuRegistry.registerMenuAction(fileOpenMenu, {
                        commandId: 'open'
                    });
                    menuRegistry.registerMenuAction(fileOpenMenu, {
                        commandId: 'open.with'
                    });
                }
            }, {
                registerCommands(reg) {
                    reg.registerCommand({
                        id: 'open',
                        label: 'A'
                    });
                    reg.registerCommand({
                        id: 'open.with',
                        label: 'B'
                    });
                }
            });
            const main = service.getMenu(['main']);
            expect(main.children.length).equals(1);
            expect(main.id, 'main');
            const file = main.children[0];
            expect(file.children.length).equals(1);
            expect(file.label, 'File');
            const openGroup = file.children[0];
            expect(openGroup.children.length).equals(2);
            expect(openGroup.label).undefined;
            expect(service.getMenuNode([...fileOpenMenu, 'open'])).exist;
            expect(service.getMenuNode([...fileOpenMenu, 'Gurkensalat'])).undefined;
        });
        it('Should not allow to register cyclic menus.', () => {
            const fileMenu = ['main', 'File'];
            const fileOpenMenu = [...fileMenu, '0_open'];
            const fileCloseMenu = [...fileMenu, '1_close'];
            const service = createMenuRegistry({
                registerMenus(menuRegistry) {
                    menuRegistry.registerSubmenu(fileMenu, 'File');
                    menuRegistry.registerSubmenu(fileOpenMenu, 'Open');
                    menuRegistry.registerSubmenu(fileCloseMenu, 'Close');
                    // open menu should not be added to open menu
                    try {
                        menuRegistry.linkCompoundMenuNode({ newParentPath: fileOpenMenu, submenuPath: fileOpenMenu });
                    }
                    catch (e) {
                        // expected
                    }
                    // close menu should be added
                    menuRegistry.linkCompoundMenuNode({ newParentPath: fileOpenMenu, submenuPath: fileCloseMenu });
                }
            }, {
                registerCommands(reg) { }
            });
            const main = service.getMenu(['main']);
            expect(menuStructureToString(main)).equals('File(0_open(1_close()),1_close())');
        });
        it('Should expose linked submenu when expressions on the public node type.', () => {
            const fileMenu = ['main', 'File'];
            const editMenu = ['main', 'Edit'];
            const service = createMenuRegistry({
                registerMenus(menuRegistry) {
                    menuRegistry.registerSubmenu(fileMenu, 'File', { when: 'fileWhen' });
                    menuRegistry.registerSubmenu(editMenu, 'Edit');
                    menuRegistry.linkCompoundMenuNode({ newParentPath: editMenu, submenuPath: fileMenu, when: 'linkWhen' });
                }
            }, {
                registerCommands(reg) { }
            });
            const linkedFileMenu = service.getMenuNode([...editMenu, 'File']);
            expect(linkedFileMenu?.when).equals('(fileWhen) && (linkWhen)');
        });
    });
});
function createMenuRegistry(menuContrib, commandContrib) {
    const cmdReg = new common_1.CommandRegistry({ getContributions: () => [commandContrib] });
    cmdReg.onStart();
    const menuReg = new common_1.MenuModelRegistry({ getContributions: () => [menuContrib] }, cmdReg, new TestMenuNodeFactory());
    menuReg.onStart();
    return menuReg;
}
function menuStructureToString(node) {
    return node.children.map(c => {
        if (common_1.CompoundMenuNode.is(c)) {
            return `${c.id}(${menuStructureToString(c)})`;
        }
        return c.id;
    }).join(',');
}
//# sourceMappingURL=menu.spec.js.map