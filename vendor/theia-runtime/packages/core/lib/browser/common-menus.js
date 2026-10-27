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
exports.CommonMenus = void 0;
const menu_1 = require("../common/menu");
var CommonMenus;
(function (CommonMenus) {
    CommonMenus.FILE = [...menu_1.MAIN_MENU_BAR, '1_file'];
    CommonMenus.FILE_NEW_TEXT = [...CommonMenus.FILE, '1_new_text'];
    CommonMenus.FILE_NEW = [...CommonMenus.FILE, '1_new'];
    CommonMenus.FILE_OPEN = [...CommonMenus.FILE, '2_open'];
    CommonMenus.FILE_SAVE = [...CommonMenus.FILE, '3_save'];
    CommonMenus.FILE_AUTOSAVE = [...CommonMenus.FILE, '4_autosave'];
    CommonMenus.FILE_SETTINGS = [...CommonMenus.FILE, '5_settings'];
    CommonMenus.FILE_SETTINGS_SUBMENU = [...CommonMenus.FILE_SETTINGS, '1_settings_submenu'];
    CommonMenus.FILE_SETTINGS_SUBMENU_OPEN = [...CommonMenus.FILE_SETTINGS_SUBMENU, '1_settings_submenu_open'];
    CommonMenus.FILE_SETTINGS_SUBMENU_THEME = [...CommonMenus.FILE_SETTINGS_SUBMENU, '2_settings_submenu_theme'];
    CommonMenus.FILE_CLOSE = [...CommonMenus.FILE, '6_close'];
    CommonMenus.FILE_NEW_CONTRIBUTIONS = ['file', 'newFile'];
    CommonMenus.EDIT = [...menu_1.MAIN_MENU_BAR, '2_edit'];
    CommonMenus.EDIT_UNDO = [...CommonMenus.EDIT, '1_undo'];
    CommonMenus.EDIT_CLIPBOARD = [...CommonMenus.EDIT, '2_clipboard'];
    CommonMenus.EDIT_FIND = [...CommonMenus.EDIT, '3_find'];
    CommonMenus.VIEW = [...menu_1.MAIN_MENU_BAR, '4_view'];
    CommonMenus.VIEW_PRIMARY = [...CommonMenus.VIEW, '0_primary'];
    CommonMenus.VIEW_APPEARANCE = [...CommonMenus.VIEW, '1_appearance'];
    CommonMenus.VIEW_APPEARANCE_SUBMENU = [...CommonMenus.VIEW_APPEARANCE, '1_appearance_submenu'];
    CommonMenus.VIEW_APPEARANCE_SUBMENU_SCREEN = [...CommonMenus.VIEW_APPEARANCE_SUBMENU, '2_appearance_submenu_screen'];
    CommonMenus.VIEW_APPEARANCE_SUBMENU_BAR = [...CommonMenus.VIEW_APPEARANCE_SUBMENU, '3_appearance_submenu_bar'];
    CommonMenus.VIEW_EDITOR_SUBMENU = [...CommonMenus.VIEW_APPEARANCE, '2_editor_submenu'];
    CommonMenus.VIEW_EDITOR_SUBMENU_SPLIT = [...CommonMenus.VIEW_EDITOR_SUBMENU, '1_editor_submenu_split'];
    CommonMenus.VIEW_EDITOR_SUBMENU_ORTHO = [...CommonMenus.VIEW_EDITOR_SUBMENU, '2_editor_submenu_ortho'];
    CommonMenus.VIEW_VIEWS = [...CommonMenus.VIEW, '2_views'];
    CommonMenus.VIEW_LAYOUT = [...CommonMenus.VIEW, '3_layout'];
    CommonMenus.VIEW_TOGGLE = [...CommonMenus.VIEW, '4_toggle'];
    CommonMenus.MANAGE_GENERAL = [...menu_1.MANAGE_MENU, '1_manage_general'];
    CommonMenus.MANAGE_SETTINGS = [...menu_1.MANAGE_MENU, '2_manage_settings'];
    CommonMenus.MANAGE_SETTINGS_THEMES = [...CommonMenus.MANAGE_SETTINGS, '1_manage_settings_themes'];
    // last menu item
    CommonMenus.HELP = [...menu_1.MAIN_MENU_BAR, '9_help'];
})(CommonMenus || (exports.CommonMenus = CommonMenus = {}));
//# sourceMappingURL=common-menus.js.map