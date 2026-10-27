/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as nls from '../../nls.js';
import { RawContextKey } from '../../platform/contextkey/common/contextkey.js';
export var EditorContextKeys;
(function (EditorContextKeys) {
    EditorContextKeys.editorSimpleInput = new RawContextKey('editorSimpleInput', false, true);
    /**
     * A context key that is set when the editor's text has focus (cursor is blinking).
     * Is false when focus is in simple editor widgets (repl input, scm commit input).
     */
    EditorContextKeys.editorTextFocus = new RawContextKey('editorTextFocus', false, nls.localize(762, "Whether the editor text has focus (cursor is blinking)"));
    /**
     * A context key that is set when the editor's text or an editor's widget has focus.
     */
    EditorContextKeys.focus = new RawContextKey('editorFocus', false, nls.localize(763, "Whether the editor or an editor widget has focus (e.g. focus is in the find widget)"));
    /**
     * A context key that is set when any editor input has focus (regular editor, repl input...).
     */
    EditorContextKeys.textInputFocus = new RawContextKey('textInputFocus', false, nls.localize(764, "Whether an editor or a rich text input has focus (cursor is blinking)"));
    EditorContextKeys.readOnly = new RawContextKey('editorReadonly', false, nls.localize(765, "Whether the editor is read-only"));
    EditorContextKeys.inDiffEditor = new RawContextKey('inDiffEditor', false, nls.localize(766, "Whether the context is a diff editor"));
    EditorContextKeys.isEmbeddedDiffEditor = new RawContextKey('isEmbeddedDiffEditor', false, nls.localize(767, "Whether the context is an embedded diff editor"));
    EditorContextKeys.inMultiDiffEditor = new RawContextKey('inMultiDiffEditor', false, nls.localize(768, "Whether the context is a multi diff editor"));
    EditorContextKeys.multiDiffEditorAllCollapsed = new RawContextKey('multiDiffEditorAllCollapsed', undefined, nls.localize(769, "Whether all files in multi diff editor are collapsed"));
    EditorContextKeys.hasChanges = new RawContextKey('diffEditorHasChanges', false, nls.localize(770, "Whether the diff editor has changes"));
    EditorContextKeys.comparingMovedCode = new RawContextKey('comparingMovedCode', false, nls.localize(771, "Whether a moved code block is selected for comparison"));
    EditorContextKeys.accessibleDiffViewerVisible = new RawContextKey('accessibleDiffViewerVisible', false, nls.localize(772, "Whether the accessible diff viewer is visible"));
    EditorContextKeys.diffEditorRenderSideBySideInlineBreakpointReached = new RawContextKey('diffEditorRenderSideBySideInlineBreakpointReached', false, nls.localize(773, "Whether the diff editor render side by side inline breakpoint is reached"));
    EditorContextKeys.diffEditorInlineMode = new RawContextKey('diffEditorInlineMode', false, nls.localize(774, "Whether inline mode is active"));
    EditorContextKeys.diffEditorOriginalWritable = new RawContextKey('diffEditorOriginalWritable', false, nls.localize(775, "Whether modified is writable in the diff editor"));
    EditorContextKeys.diffEditorModifiedWritable = new RawContextKey('diffEditorModifiedWritable', false, nls.localize(776, "Whether modified is writable in the diff editor"));
    EditorContextKeys.diffEditorOriginalUri = new RawContextKey('diffEditorOriginalUri', '', nls.localize(777, "The uri of the original document"));
    EditorContextKeys.diffEditorModifiedUri = new RawContextKey('diffEditorModifiedUri', '', nls.localize(778, "The uri of the modified document"));
    EditorContextKeys.columnSelection = new RawContextKey('editorColumnSelection', false, nls.localize(779, "Whether `editor.columnSelection` is enabled"));
    EditorContextKeys.writable = EditorContextKeys.readOnly.toNegated();
    EditorContextKeys.hasNonEmptySelection = new RawContextKey('editorHasSelection', false, nls.localize(780, "Whether the editor has text selected"));
    EditorContextKeys.hasOnlyEmptySelection = EditorContextKeys.hasNonEmptySelection.toNegated();
    EditorContextKeys.hasMultipleSelections = new RawContextKey('editorHasMultipleSelections', false, nls.localize(781, "Whether the editor has multiple selections"));
    EditorContextKeys.hasSingleSelection = EditorContextKeys.hasMultipleSelections.toNegated();
    EditorContextKeys.tabMovesFocus = new RawContextKey('editorTabMovesFocus', false, nls.localize(782, "Whether `Tab` will move focus out of the editor"));
    EditorContextKeys.tabDoesNotMoveFocus = EditorContextKeys.tabMovesFocus.toNegated();
    EditorContextKeys.isInEmbeddedEditor = new RawContextKey('isInEmbeddedEditor', false, true);
    EditorContextKeys.canUndo = new RawContextKey('canUndo', false, true);
    EditorContextKeys.canRedo = new RawContextKey('canRedo', false, true);
    EditorContextKeys.hoverVisible = new RawContextKey('editorHoverVisible', false, nls.localize(783, "Whether the editor hover is visible"));
    EditorContextKeys.hoverFocused = new RawContextKey('editorHoverFocused', false, nls.localize(784, "Whether the editor hover is focused"));
    EditorContextKeys.stickyScrollFocused = new RawContextKey('stickyScrollFocused', false, nls.localize(785, "Whether the sticky scroll is focused"));
    EditorContextKeys.stickyScrollVisible = new RawContextKey('stickyScrollVisible', false, nls.localize(786, "Whether the sticky scroll is visible"));
    EditorContextKeys.standaloneColorPickerVisible = new RawContextKey('standaloneColorPickerVisible', false, nls.localize(787, "Whether the standalone color picker is visible"));
    EditorContextKeys.standaloneColorPickerFocused = new RawContextKey('standaloneColorPickerFocused', false, nls.localize(788, "Whether the standalone color picker is focused"));
    /**
     * A context key that is set when an editor is part of a larger editor, like notebooks or
     * (future) a diff editor
     */
    EditorContextKeys.inCompositeEditor = new RawContextKey('inCompositeEditor', undefined, nls.localize(789, "Whether the editor is part of a larger editor (e.g. notebooks)"));
    EditorContextKeys.notInCompositeEditor = EditorContextKeys.inCompositeEditor.toNegated();
    // -- mode context keys
    EditorContextKeys.languageId = new RawContextKey('editorLangId', '', nls.localize(790, "The language identifier of the editor"));
    EditorContextKeys.hasCompletionItemProvider = new RawContextKey('editorHasCompletionItemProvider', false, nls.localize(791, "Whether the editor has a completion item provider"));
    EditorContextKeys.hasCodeActionsProvider = new RawContextKey('editorHasCodeActionsProvider', false, nls.localize(792, "Whether the editor has a code actions provider"));
    EditorContextKeys.hasCodeLensProvider = new RawContextKey('editorHasCodeLensProvider', false, nls.localize(793, "Whether the editor has a code lens provider"));
    EditorContextKeys.hasDefinitionProvider = new RawContextKey('editorHasDefinitionProvider', false, nls.localize(794, "Whether the editor has a definition provider"));
    EditorContextKeys.hasDeclarationProvider = new RawContextKey('editorHasDeclarationProvider', false, nls.localize(795, "Whether the editor has a declaration provider"));
    EditorContextKeys.hasImplementationProvider = new RawContextKey('editorHasImplementationProvider', false, nls.localize(796, "Whether the editor has an implementation provider"));
    EditorContextKeys.hasTypeDefinitionProvider = new RawContextKey('editorHasTypeDefinitionProvider', false, nls.localize(797, "Whether the editor has a type definition provider"));
    EditorContextKeys.hasHoverProvider = new RawContextKey('editorHasHoverProvider', false, nls.localize(798, "Whether the editor has a hover provider"));
    EditorContextKeys.hasDocumentHighlightProvider = new RawContextKey('editorHasDocumentHighlightProvider', false, nls.localize(799, "Whether the editor has a document highlight provider"));
    EditorContextKeys.hasDocumentSymbolProvider = new RawContextKey('editorHasDocumentSymbolProvider', false, nls.localize(800, "Whether the editor has a document symbol provider"));
    EditorContextKeys.hasReferenceProvider = new RawContextKey('editorHasReferenceProvider', false, nls.localize(801, "Whether the editor has a reference provider"));
    EditorContextKeys.hasRenameProvider = new RawContextKey('editorHasRenameProvider', false, nls.localize(802, "Whether the editor has a rename provider"));
    EditorContextKeys.hasSignatureHelpProvider = new RawContextKey('editorHasSignatureHelpProvider', false, nls.localize(803, "Whether the editor has a signature help provider"));
    EditorContextKeys.hasInlayHintsProvider = new RawContextKey('editorHasInlayHintsProvider', false, nls.localize(804, "Whether the editor has an inline hints provider"));
    // -- mode context keys: formatting
    EditorContextKeys.hasDocumentFormattingProvider = new RawContextKey('editorHasDocumentFormattingProvider', false, nls.localize(805, "Whether the editor has a document formatting provider"));
    EditorContextKeys.hasDocumentSelectionFormattingProvider = new RawContextKey('editorHasDocumentSelectionFormattingProvider', false, nls.localize(806, "Whether the editor has a document selection formatting provider"));
    EditorContextKeys.hasMultipleDocumentFormattingProvider = new RawContextKey('editorHasMultipleDocumentFormattingProvider', false, nls.localize(807, "Whether the editor has multiple document formatting providers"));
    EditorContextKeys.hasMultipleDocumentSelectionFormattingProvider = new RawContextKey('editorHasMultipleDocumentSelectionFormattingProvider', false, nls.localize(808, "Whether the editor has multiple document selection formatting providers"));
})(EditorContextKeys || (EditorContextKeys = {}));
//# sourceMappingURL=editorContextKeys.js.map