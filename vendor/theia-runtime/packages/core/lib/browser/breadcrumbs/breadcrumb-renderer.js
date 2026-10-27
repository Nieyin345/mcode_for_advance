"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultBreadcrumbRenderer = exports.BreadcrumbRenderer = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("react/jsx-runtime");
const inversify_1 = require("inversify");
const breadcrumbs_constants_1 = require("./breadcrumbs-constants");
exports.BreadcrumbRenderer = Symbol('BreadcrumbRenderer');
let DefaultBreadcrumbRenderer = class DefaultBreadcrumbRenderer {
    render(breadcrumb, onMouseDown) {
        return (0, jsx_runtime_1.jsxs)("li", { title: breadcrumb.longLabel, className: breadcrumbs_constants_1.Styles.BREADCRUMB_ITEM + (!onMouseDown ? '' : ' ' + breadcrumbs_constants_1.Styles.BREADCRUMB_ITEM_HAS_POPUP), onMouseDown: event => onMouseDown && onMouseDown(breadcrumb, event), tabIndex: 0, "data-breadcrumb-id": breadcrumb.id, children: [breadcrumb.iconClass && (0, jsx_runtime_1.jsx)("span", { className: breadcrumb.iconClass }), " ", (0, jsx_runtime_1.jsxs)("span", { children: [" ", breadcrumb.label] })] }, breadcrumb.id);
    }
};
exports.DefaultBreadcrumbRenderer = DefaultBreadcrumbRenderer;
exports.DefaultBreadcrumbRenderer = DefaultBreadcrumbRenderer = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DefaultBreadcrumbRenderer);
//# sourceMappingURL=breadcrumb-renderer.js.map