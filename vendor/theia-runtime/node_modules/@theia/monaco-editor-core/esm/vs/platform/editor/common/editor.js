/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { equals } from '../../../base/common/arrays.js';
export function isResolvedEditorModel(model) {
    const candidate = model;
    return typeof candidate?.resolve === 'function'
        && typeof candidate?.isResolved === 'function';
}
export var EditorActivation;
(function (EditorActivation) {
    /**
     * Activate the editor after it opened. This will automatically restore
     * the editor if it is minimized.
     */
    EditorActivation[EditorActivation["ACTIVATE"] = 1] = "ACTIVATE";
    /**
     * Only restore the editor if it is minimized but do not activate it.
     *
     * Note: will only work in combination with the `preserveFocus: true` option.
     * Otherwise, if focus moves into the editor, it will activate and restore
     * automatically.
     */
    EditorActivation[EditorActivation["RESTORE"] = 2] = "RESTORE";
    /**
     * Preserve the current active editor.
     *
     * Note: will only work in combination with the `preserveFocus: true` option.
     * Otherwise, if focus moves into the editor, it will activate and restore
     * automatically.
     */
    EditorActivation[EditorActivation["PRESERVE"] = 3] = "PRESERVE";
})(EditorActivation || (EditorActivation = {}));
export var EditorResolution;
(function (EditorResolution) {
    /**
     * Displays a picker and allows the user to decide which editor to use.
     */
    EditorResolution[EditorResolution["PICK"] = 0] = "PICK";
    /**
     * Only exclusive editors are considered.
     */
    EditorResolution[EditorResolution["EXCLUSIVE_ONLY"] = 1] = "EXCLUSIVE_ONLY";
})(EditorResolution || (EditorResolution = {}));
export var EditorOpenSource;
(function (EditorOpenSource) {
    /**
     * Default: the editor is opening via a programmatic call
     * to the editor service API.
     */
    EditorOpenSource[EditorOpenSource["API"] = 0] = "API";
    /**
     * Indicates that a user action triggered the opening, e.g.
     * via mouse or keyboard use.
     */
    EditorOpenSource[EditorOpenSource["USER"] = 1] = "USER";
})(EditorOpenSource || (EditorOpenSource = {}));
export function isTextEditorDiffInformationEqual(uriIdentityService, diff1, diff2) {
    return diff1?.documentVersion === diff2?.documentVersion &&
        uriIdentityService.extUri.isEqual(diff1?.original, diff2?.original) &&
        uriIdentityService.extUri.isEqual(diff1?.modified, diff2?.modified) &&
        equals(diff1?.changes, diff2?.changes, (a, b) => {
            return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
        });
}
//# sourceMappingURL=editor.js.map