"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SinglePageCategoryRenderer = void 0;
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
/**
 * Convenience base for `single-page` categories. Subclasses implement
 * {@link renderSections} (and optionally {@link renderHeader}); the page frame
 * and scrolling container are provided.
 */
class SinglePageCategoryRenderer {
    renderPage(ctx) {
        return (0, jsx_runtime_1.jsxs)("div", { className: 'ai-configuration-page', children: [this.renderHeader(ctx), this.renderSections(ctx)] });
    }
    /** Optional page header (title/description); nothing by default. */
    renderHeader(ctx) {
        return undefined;
    }
}
exports.SinglePageCategoryRenderer = SinglePageCategoryRenderer;
//# sourceMappingURL=single-page-category-renderer.js.map