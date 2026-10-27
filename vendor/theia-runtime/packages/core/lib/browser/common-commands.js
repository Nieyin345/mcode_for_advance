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
exports.CommonCommands = void 0;
const command_1 = require("../common/command");
const nls_1 = require("../common/nls");
var CommonCommands;
(function (CommonCommands) {
    CommonCommands.FILE_CATEGORY = 'File';
    CommonCommands.VIEW_CATEGORY = 'View';
    CommonCommands.CREATE_CATEGORY = 'Create';
    CommonCommands.PREFERENCES_CATEGORY = 'Preferences';
    CommonCommands.MANAGE_CATEGORY = 'Manage';
    CommonCommands.FILE_CATEGORY_KEY = nls_1.nls.getDefaultKey(CommonCommands.FILE_CATEGORY);
    CommonCommands.VIEW_CATEGORY_KEY = nls_1.nls.getDefaultKey(CommonCommands.VIEW_CATEGORY);
    CommonCommands.PREFERENCES_CATEGORY_KEY = nls_1.nls.getDefaultKey(CommonCommands.PREFERENCES_CATEGORY);
    CommonCommands.OPEN = {
        id: 'core.open',
    };
    CommonCommands.CUT = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.cut',
        label: 'Cut'
    });
    CommonCommands.COPY = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.copy',
        label: 'Copy'
    });
    CommonCommands.PASTE = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.paste',
        label: 'Paste'
    });
    CommonCommands.COPY_PATH = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.copy.path',
        label: 'Copy Path'
    });
    CommonCommands.UNDO = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.undo',
        label: 'Undo'
    });
    CommonCommands.REDO = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.redo',
        label: 'Redo'
    });
    CommonCommands.SELECT_ALL = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.selectAll',
        label: 'Select All'
    });
    CommonCommands.FIND = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.find',
        label: 'Find'
    });
    CommonCommands.REPLACE = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.replace',
        label: 'Replace'
    });
    CommonCommands.NEXT_TAB = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.nextTab',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Show Next Tab'
    });
    CommonCommands.PREVIOUS_TAB = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.previousTab',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Show Previous Tab'
    });
    CommonCommands.NEXT_TAB_IN_GROUP = command_1.Command.toLocalizedCommand({
        id: 'core.nextTabInGroup',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Switch to Next Tab in Group'
    }, 'theia/core/common/showNextTabInGroup', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.PREVIOUS_TAB_IN_GROUP = command_1.Command.toLocalizedCommand({
        id: 'core.previousTabInGroup',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Switch to Previous Tab in Group'
    }, 'theia/core/common/showPreviousTabInGroup', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.NEXT_TAB_GROUP = command_1.Command.toLocalizedCommand({
        id: 'core.nextTabGroup',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Switch to Next Tab Group'
    }, 'theia/core/common/showNextTabGroup', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.PREVIOUS_TAB_GROUP = command_1.Command.toLocalizedCommand({
        id: 'core.previousTabBar',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Switch to Previous Tab Group'
    }, 'theia/core/common/showPreviousTabGroup', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.CLOSE_TAB = command_1.Command.toLocalizedCommand({
        id: 'core.close.tab',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Close Tab'
    }, 'theia/core/common/closeTab', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.CLOSE_OTHER_TABS = command_1.Command.toLocalizedCommand({
        id: 'core.close.other.tabs',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Close Other Tabs'
    }, 'theia/core/common/closeOthers', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.CLOSE_SAVED_TABS = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.closeUnmodifiedEditors',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Close Saved Editors in Group',
    });
    CommonCommands.CLOSE_RIGHT_TABS = command_1.Command.toLocalizedCommand({
        id: 'core.close.right.tabs',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Close Tabs to the Right'
    }, 'theia/core/common/closeRight', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.CLOSE_ALL_TABS = command_1.Command.toLocalizedCommand({
        id: 'core.close.all.tabs',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Close All Tabs'
    }, 'theia/core/common/closeAll', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.CLOSE_MAIN_TAB = command_1.Command.toLocalizedCommand({
        id: 'core.close.main.tab',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Close Tab in Main Area'
    }, 'theia/core/common/closeTabMain', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.CLOSE_OTHER_MAIN_TABS = command_1.Command.toLocalizedCommand({
        id: 'core.close.other.main.tabs',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Close Other Tabs in Main Area'
    }, 'theia/core/common/closeOtherTabMain', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.CLOSE_ALL_MAIN_TABS = command_1.Command.toLocalizedCommand({
        id: 'core.close.all.main.tabs',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Close All Tabs in Main Area'
    }, 'theia/core/common/closeAllTabMain', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.COLLAPSE_PANEL = command_1.Command.toLocalizedCommand({
        id: 'core.collapse.tab',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Collapse Side Panel'
    }, 'theia/core/common/collapseTab', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.COLLAPSE_ALL_PANELS = command_1.Command.toLocalizedCommand({
        id: 'core.collapse.all.tabs',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Collapse All Side Panels'
    }, 'theia/core/common/collapseAllTabs', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.TOGGLE_BOTTOM_PANEL = command_1.Command.toLocalizedCommand({
        id: 'core.toggle.bottom.panel',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Toggle Bottom Panel'
    }, 'theia/core/common/collapseBottomPanel', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.TOGGLE_LEFT_PANEL = command_1.Command.toLocalizedCommand({
        id: 'core.toggle.left.panel',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Toggle Left Panel'
    }, 'theia/core/common/collapseLeftPanel', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.TOGGLE_RIGHT_PANEL = command_1.Command.toLocalizedCommand({
        id: 'core.toggle.right.panel',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Toggle Right Panel'
    }, 'theia/core/common/collapseRightPanel', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.TOGGLE_STATUS_BAR = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.toggleStatusbarVisibility',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Toggle Status Bar Visibility'
    });
    CommonCommands.PIN_TAB = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.pinEditor',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Pin Editor'
    });
    CommonCommands.UNPIN_TAB = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.unpinEditor',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Unpin Editor'
    });
    CommonCommands.TOGGLE_MAXIMIZED = command_1.Command.toLocalizedCommand({
        id: 'core.toggleMaximized',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Toggle Maximized'
    }, 'theia/core/common/toggleMaximized', CommonCommands.VIEW_CATEGORY_KEY);
    CommonCommands.OPEN_VIEW = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.openView',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Open View...'
    });
    CommonCommands.SHOW_MENU_BAR = command_1.Command.toDefaultLocalizedCommand({
        id: 'window.menuBarVisibility',
        category: CommonCommands.VIEW_CATEGORY,
        label: 'Toggle Menu Bar'
    });
    /**
     * Command Parameters:
     * - `fileName`: string
     * - `directory`: URI
     */
    CommonCommands.NEW_FILE = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.files.newFile',
        category: CommonCommands.FILE_CATEGORY
    });
    // This command immediately opens a new untitled text file
    // Some VS Code extensions use this command to create new files
    CommonCommands.NEW_UNTITLED_TEXT_FILE = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.files.newUntitledFile',
        category: CommonCommands.FILE_CATEGORY,
        label: 'New Untitled Text File'
    });
    // This command opens a quick pick to select a file type to create
    CommonCommands.PICK_NEW_FILE = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.files.pickNewFile',
        category: CommonCommands.CREATE_CATEGORY,
        label: 'New File...'
    });
    CommonCommands.SAVE = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.save',
        category: CommonCommands.FILE_CATEGORY,
        label: 'Save',
    });
    CommonCommands.SAVE_AS = command_1.Command.toDefaultLocalizedCommand({
        id: 'file.saveAs',
        category: CommonCommands.FILE_CATEGORY,
        label: 'Save As...',
    });
    CommonCommands.SAVE_WITHOUT_FORMATTING = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.saveWithoutFormatting',
        category: CommonCommands.FILE_CATEGORY,
        label: 'Save without Formatting',
    });
    CommonCommands.SAVE_ALL = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.saveAll',
        category: CommonCommands.FILE_CATEGORY,
        label: 'Save All',
    });
    CommonCommands.AUTO_SAVE = command_1.Command.toDefaultLocalizedCommand({
        id: 'textEditor.commands.autosave',
        category: CommonCommands.FILE_CATEGORY,
        label: 'Auto Save',
    });
    CommonCommands.ABOUT_COMMAND = command_1.Command.toDefaultLocalizedCommand({
        id: 'core.about',
        label: 'About'
    });
    CommonCommands.OPEN_PREFERENCES = command_1.Command.toDefaultLocalizedCommand({
        id: 'preferences:open',
        category: CommonCommands.PREFERENCES_CATEGORY,
        label: 'Open Settings (UI)',
    });
    CommonCommands.SELECT_COLOR_THEME = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.selectTheme',
        label: 'Color Theme',
        category: CommonCommands.PREFERENCES_CATEGORY
    });
    CommonCommands.SELECT_ICON_THEME = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.selectIconTheme',
        label: 'File Icon Theme',
        category: CommonCommands.PREFERENCES_CATEGORY
    });
    CommonCommands.CONFIGURE_DISPLAY_LANGUAGE = command_1.Command.toDefaultLocalizedCommand({
        id: 'workbench.action.configureLanguage',
        label: 'Configure Display Language'
    });
    CommonCommands.TOGGLE_BREADCRUMBS = command_1.Command.toDefaultLocalizedCommand({
        id: 'breadcrumbs.toggle',
        label: 'Toggle Breadcrumbs',
        category: CommonCommands.VIEW_CATEGORY
    });
})(CommonCommands || (exports.CommonCommands = CommonCommands = {}));
//# sourceMappingURL=common-commands.js.map