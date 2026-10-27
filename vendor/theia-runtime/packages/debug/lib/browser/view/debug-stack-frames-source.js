"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoadMoreStackFrames = exports.DebugStackFramesSource = void 0;
const tslib_1 = require("tslib");
const jsx_runtime_1 = require("@theia/core/shared/react/jsx-runtime");
const inversify_1 = require("@theia/core/shared/inversify");
const source_tree_1 = require("@theia/core/lib/browser/source-tree");
const debug_view_model_1 = require("./debug-view-model");
const debounce = require("p-debounce");
const core_1 = require("@theia/core");
let DebugStackFramesSource = class DebugStackFramesSource extends source_tree_1.TreeSource {
    constructor() {
        super(...arguments);
        this.refresh = debounce(() => this.fireDidChange(), 100);
    }
    init() {
        this.refresh();
        this.toDispose.push(this.model.onDidChange(() => this.refresh()));
    }
    *getElements() {
        const thread = this.model.currentThread;
        if (!thread) {
            return;
        }
        yield* thread.frames;
        if (thread.stoppedDetails) {
            const { framesErrorMessage, totalFrames } = thread.stoppedDetails;
            if (framesErrorMessage) {
                yield {
                    render: () => (0, jsx_runtime_1.jsx)("span", { title: framesErrorMessage, children: framesErrorMessage })
                };
            }
            if (totalFrames && totalFrames > thread.frameCount) {
                yield new LoadMoreStackFrames(thread);
            }
        }
    }
};
exports.DebugStackFramesSource = DebugStackFramesSource;
tslib_1.__decorate([
    (0, inversify_1.inject)(debug_view_model_1.DebugViewModel),
    tslib_1.__metadata("design:type", debug_view_model_1.DebugViewModel)
], DebugStackFramesSource.prototype, "model", void 0);
tslib_1.__decorate([
    (0, inversify_1.postConstruct)(),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", void 0)
], DebugStackFramesSource.prototype, "init", null);
exports.DebugStackFramesSource = DebugStackFramesSource = tslib_1.__decorate([
    (0, inversify_1.injectable)()
], DebugStackFramesSource);
class LoadMoreStackFrames {
    constructor(thread) {
        this.thread = thread;
    }
    render() {
        return (0, jsx_runtime_1.jsx)("span", { className: 'theia-load-more-frames', children: core_1.nls.localizeByDefault('Load More Stack Frames') });
    }
    async open() {
        const frames = await this.thread.fetchFrames();
        if (frames[0]) {
            this.thread.currentFrame = frames[0];
        }
    }
}
exports.LoadMoreStackFrames = LoadMoreStackFrames;
//# sourceMappingURL=debug-stack-frames-source.js.map