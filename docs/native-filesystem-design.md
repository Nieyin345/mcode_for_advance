# Native filesystem root module

**Status:** Electron 44.4.5 N-API builds and native security smokes validated on Windows x64, Linux x64, macOS arm64 and macOS x64. GitHub Actions PR run #470 passed all six jobs; the follow-up revision adds a fourth package-layout smoke and skips unused Electron runtime downloads in the native-only jobs. Hosted validation of that revision is in progress (2026-10-31).
**Scope:** B-02 Markdown preview reads and B-05 Theia workspace filesystem operations.

## Decision

Introduce one small N-API module that opens a selected directory once and exposes operations relative to that pinned directory handle. TypeScript callers pass validated path components, never an absolute path for each operation.

The native module is the only implementation of path traversal and leaf opening for these two callers. It does not replace unrelated filesystem access across the application.

## Security invariants

1. The root is opened once and held by an OS handle for the lifetime of the root object.
2. Every path component is a single name. Empty names, \`.\`, \`..\`, separators, NUL, drive/stream syntax, and non-portable Windows names are rejected before reaching the OS.
3. Intermediate directories are opened one component at a time relative to the already-open parent handle. Symbolic links, junctions, mount-point reparse entries, and other reparse points are rejected.
4. Leaf files are opened relative to their pinned parent handle with no-follow semantics. Reads and writes require ordinary files; multiply-linked files are rejected for read/write to preserve the current hard-link policy.
5. Create, rename, copy, and remove operate relative to pinned parent handles. No operation re-resolves a user-controlled absolute path after authorization.
6. Reads have an explicit byte cap. Directory enumeration has an explicit entry cap. Recursive deletion is not part of the Theia contract and remains unsupported.
7. No insecure path-based fallback is allowed when the native module is unavailable. The caller must fail closed with an actionable build/runtime error.

## Platform implementation

- **Linux:** directory descriptors plus \`openat\` / \`fstatat\` / \`mkdirat\` / \`unlinkat\` / \`renameat2\`. Every intermediate component is opened with \`O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC\`. \`renameat2(RENAME_NOREPLACE)\` provides atomic no-replace semantics; if unavailable, the operation fails closed rather than falling back to a racy pre-check.
- **macOS:** the same descriptor-relative walk and \`*at\` operations, with \`renameatx_np(RENAME_EXCL)\` for no-replace publication.
- **Windows:** a directory handle is retained at each walk step. Child opens use \`NtCreateFile\` with \`OBJECT_ATTRIBUTES.RootDirectory\`, \`OBJ_DONT_REPARSE\`, and \`FILE_OPEN_REPARSE_POINT\`. Metadata and ordinary mutations use the returned handles. Create operations open their immediate parent with the required FILE_ADD_FILE / FILE_ADD_SUBDIRECTORY access; rename uses \`NtSetInformationFile(FileRenameInformation)\` with the destination directory handle because the Win32 \`SetFileInformationByHandle\` wrapper rejects a non-null \`RootDirectory\` on the tested Windows implementation. The Native API calls are isolated to one platform file and resolved from \`ntdll.dll\` at runtime.

POSIX leaf reads and writes use O_NONBLOCK so opening a FIFO does not wait for a peer; the opened handle is then `fstat`-checked and non-regular entries are rejected before data I/O. The relevant OS contracts are documented by Microsoft for \`NtCreateFile\` root-relative names and reparse handling, by Microsoft for \`OBJECT_ATTRIBUTES.RootDirectory\` / \`OBJ_DONT_REPARSE\`, and by Microsoft for handle-relative \`FILE_RENAME_INFO.RootDirectory\`. Linux uses the descriptor-relative operations documented by \`openat(2)\` and \`renameat2(2)\`; macOS exposes \`O_NOFOLLOW\` for \`open(2)\` and \`renameatx_np(2)\` for exclusive rename.

## TypeScript interface

The native module exports \`openRoot(absoluteRoot)\`. The returned root exposes promise-based:

- \`stat(segments)\`
- \`readdir(segments, maxEntries)\`
- \`readFile(segments, maxBytes)\`
- \`writeFile(segments, bytes, exclusive)\`
- \`mkdir(segments)\`
- \`rename(fromSegments, toSegments, overwrite)\`
- \`copy(fromSegments, toSegments, overwrite)\`
- \`remove(segments)\`
- \`close()\`

An empty segment list refers only to the root for \`stat\` and \`readdir\`; mutating methods reject it.

## Integration order

1. N-API implementation and Electron-version/architecture build path are in place.
2. Native adversarial tests cover traversal, symlinks/junctions, hard links, no-replace and overwrite semantics, and the supported operations.
3. Theia's \`McodeWorkspaceFs\` now routes file operations through the pinned native root; TypeScript retains URI parsing, bounded glob traversal, and lifecycle management. Workspace watcher events are revalidated through the same native root instead of path-based \`lstat\`/\`realpath\`; the root closes on host exit/disposal and on registry startup failure.
4. Markdown preview and local-image inlining now use the native root; the IPC handler awaits the asynchronous read.
5. The Windows x64 addon was built against Electron 44.4.5 and passed the focused security smokes. The POSIX addon compiled in an Ubuntu 24.04 container against Node 24.22.1 headers with N-API 8 and passed native-fs-smoke 62/62. GitHub Actions PR run #470 built the Electron-target addon and passed the three original focused suites on Linux, Windows, macOS arm64 and macOS x64; Typecheck and the broad Windows smoke job also passed. The follow-up revision adds `native-fs-package-smoke` to these platform gates and skips downloading Electron's app binary in jobs that only build/test the N-API module.

## Latest hardening (four-platform Electron-target CI validated; package guard added)

- `NativeRoot` now protects the pinned OS handle with a shared mutex: asynchronous filesystem operations hold a shared lock, while `close()` takes the exclusive lock. This prevents a close from releasing/reusing the handle while an `AsyncWorker` is still using it.
- POSIX compilation: removed an early `#endif` that closed the platform guard before `ReadDir` and the remaining methods, preventing Linux/macOS compilation. POSIX directory enumeration resets `errno` immediately before each `readdir()` call and now omits sockets, FIFOs, device entries, non-portable names, and filenames that are not valid UTF-8. Windows enumeration likewise omits device entries and skips names containing unpaired UTF-16 surrogates. Both backends count raw entries visited against `maxEntries` before filtering, so hidden symlinks/special files cannot bypass the directory-scan budget. The N-API boundary filters entries that Theia cannot round-trip through its Unicode path API.
- POSIX root walks now use `openat(root_fd, ".", ...)` rather than `dup()`/`F_DUPFD`: duplicated descriptors share the same open-file description and directory offset, so the old root `readdir()` consumed the pinned handle's offset and later root listings could appear empty. The native smoke now checks that repeated root listings restart and see files created after the first listing.
- POSIX caller-selected roots are canonicalized *once before* pinning the directory descriptor, allowing macOS system-managed `/var` and `/tmp` aliases; all subsequent child opens still require descriptor-relative no-follow lookup. The alias-retarget regression checks that the opened handle stays at the original target. The N-API entry also rejects NUL-containing selected root paths on every platform to prevent C path API truncation.
- POSIX read-integrity checks compare full nanosecond-resolution `mtime` and `ctime` in addition to inode, device, link count, and size. Millisecond-rounded values remain display-only and are no longer used to detect concurrent changes.
- Windows now falls back to a read-only handle when the final selected workspace directory cannot be opened with FILE_ADD_FILE / FILE_ADD_SUBDIRECTORY, and applies the same fallback to volume/share roots. Rename opens the source first and requests only FILE_ADD_FILE or FILE_ADD_SUBDIRECTORY for its destination based on source type.
- `native-fs-smoke` now includes root-level file create/rename/copy, repeated root-directory enumeration, same-volume directory rename with no-replace collision preservation, file copy/rename overwrite, platform-specific empty-directory replacement semantics (POSIX replaces atomically; Windows returns `ENOTSUP` and preserves both trees), Linux cross-volume directory rename returning `EXDEV` with source preservation, reserved Windows device-name rejection (including superscript COM/LPT names), zero-byte writes, close-versus-queued-operation coverage, POSIX FIFO/special-file/non-portable-name/malformed-UTF-8 regressions with a valid Unicode filename positive control.
- Cross-volume rename remains fail-closed (`EXDEV` / the corresponding Windows status); no non-atomic copy/delete fallback is attempted. Recursive deletion also remains intentionally unsupported. If either behavior becomes a product requirement, it needs a separately reviewed transaction/rollback design.
- The current Windows x64 addon was rebuilt with node-gyp 12.4.0 against Electron 44.4.5; `native-fs-smoke` passed 48/48 (file-symlink creation skipped because the current account lacks permission), and the three-suite gate passed 3/3: `workspace-copy-boundary-smoke` 38/38 and `markdown-preview-security-smoke` 11/11 (two file-symlink controls skipped for the same permission reason).
- The POSIX addon was manually compiled with g++ in an Ubuntu 24.04 container against Node 24.22.1 headers using N-API 8; `native-fs-smoke` passed 62/62, including malformed UTF-8 filtering, root re-enumeration, FIFO/symlink rejection, and a real `/tmp` to `/dev/shm` cross-volume rename returning `EXDEV` without losing the source tree. Replacing `OpenRootDirectory()` with the old `fcntl(F_DUPFD_CLOEXEC)` implementation in a temporary container copy made the new root re-enumeration assertion fail as expected, confirming the regression test is red-capable. The later hosted CI run #470 also completed the Electron 44.4.5 node-gyp target build and focused security gate on Linux and both macOS architectures.
- CI now has independent `native-fs-linux` and `native-fs-windows` jobs: each performs its Electron-target node-gyp build and runs the focused suites immediately after dependency installation, without depending on Typecheck or the broad Windows smoke job. This prevents unrelated TypeScript/application-smoke failures from suppressing native validation and reports each platform independently. PR CI also builds and runs the focused suites on macOS arm64 (`macos-latest`, matching the release workflow) and x64 (`macos-15-intel`). GitHub Actions PR run #470 executed the Linux, Windows, macOS arm64 and macOS x64 Electron-target builds and the three original focused suites on each platform; all four native jobs passed. The follow-up revision adds the packaging smoke to all four jobs and the critical gate. Native-only jobs set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`: they need the Electron package version and node-gyp headers, but their four focused suites run under Node and never launch the Electron runtime.

## Verification boundary

Windows local verification on 2026-10-31 (current source and current Windows x64 binary):
- Electron 44.4.5 native addon build: PASS (`node-gyp@12.4.0`, MSVC 2022, win32-x64).
- native-fs-smoke: 48/48 passed. File-symlink creation was skipped because the current Windows account cannot create file symlinks; directory-junction controls passed.
- workspace-copy-boundary-smoke: 38/38 passed, including literal percent signs, hashes, spaces and Unicode in file URI paths.
- markdown-preview-security-smoke: 11/11 passed. Two file-symlink controls were skipped because the current Windows account cannot create file symlinks.
- Combined focused gate: 3/3 suites passed.

Linux local container verification on 2026-10-31:
- POSIX addon: g++ compile PASS against Node 24.22.1 headers with `NAPI_VERSION=8` and the repository's node-addon-api 7.1.0 headers.
- native-fs-smoke: 62/62 passed, including a real cross-device `/tmp` → `/dev/shm` rename returning `EXDEV` while preserving the source subtree.
- The Electron 44.4.5 `build-native-fs.cjs` attempt in this container stopped before node-gyp: the image's Yarn PnP hook could not resolve `electron/package.json` through the mounted Windows pnpm layout. This is a container dependency-resolution limitation, not a native compile failure; Ubuntu CI's normal `pnpm install` path remains the authoritative Electron-target build.
- The local unified three-suite runner could not execute the other two suites because the mounted Windows `node_modules` lacks esbuild's `@esbuild/linux-x64` optional package. This is a local dependency-layout limitation; the clean hosted Ubuntu install in PR run #470 passed all three focused suites.
- PR run #470 (`28532573ba024970d378bcf238acb55b7271f9f2`) completed successfully on the current branch revision. The independent Ubuntu, Windows, macOS arm64 and macOS x64 jobs each compiled the Electron-target addon and passed the three focused native security suites.

Isolated integration verification on 2026-10-31 (latest `origin/master` baseline):
- `theia-host-boot-smoke`: PASS; the updated host module bundles and boots against the locally built Theia host.
- `theia-installed-smoke`: 150/150 PASS, including the native workspace file-listener assertion and Webview panel activation/focus checks. The earlier 149/150 result came from a stale worktree without the concurrent Webview UI changes; it did not reproduce on the current baseline.
- Six focused suites (`native-fs`, workspace-copy boundary, Markdown preview security, library entry path, Theia host boot, and Theia installed extension): 6/6 PASS.
- Smoke runner self-tests: 15/15; desktop, `packages/contracts`, and `packages/vscode-compat` TypeScript checks all pass.
- The clean integration worktree typecheck passes. The shared primary worktree's full typecheck still reports independent parallel UI/API integration errors in `theia-webview-resource-smoke/main.ts`, `renderer/App.tsx`, `renderer/components/settings/PluginsPanelParts.tsx`, and `renderer/lib/webApi.ts`; these files are outside this native-filesystem change and were not modified by this branch.

Additional verification on the isolated native-filesystem branch:
- Windows reparse protection mutation check: temporarily removed both `OBJ_DONT_REPARSE` and `FILE_OPEN_REPARSE_POINT`, forced an Electron 44.4.5 native rebuild, and confirmed `native-fs-smoke` failed at `directory symlink/junction cannot be enumerated`. Restored both protections, rebuilt, and reran the full six-suite gate successfully (6/6). The source was byte-for-byte restored to the committed implementation before final verification.
- Production desktop build: `build-native-fs.cjs`, `build-node-pack.cjs` and `electron-vite build` completed successfully (main, preload, renderer). The native addon was also force-rebuilt locally with MSVC 2022 against Electron 44.4.5 after adding explicit output-file validation and broader Visual Studio 2022 discovery across both Program Files roots. The forced rebuild also passed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, confirming the native build only needs the installed Electron package metadata and matching headers.
- Packaging guard: the new `verify-native-fs-after-pack.cjs` afterPack check locates the Windows `resources/native-fs` and macOS `Contents/Resources/native-fs` layouts, loads the packaged N-API binary, and opens/stats/closes a pinned temporary root. The resolver prefers a candidate that actually contains the addon when multiple resource roots exist. Both layout probes passed; missing-binary and empty-binary mutations failed closed as expected.
- `native-fs-package-smoke` now runs the afterPack verifier in a child process (so Windows can release the loaded `.node` file before fixture cleanup). It covers successful load/open, populated-root selection when an earlier resource directory is empty, missing binary, empty binary, and missing resource directory. The focused four-suite gate passed 4/4 locally.
- Final checks: the full critical gate passed 22/22 on rerun, including the new package smoke; the focused native gate passed 4/4; smoke-runner tests passed 15/15. One earlier full-gate run had a single internal-junction assertion miss; five consecutive isolated native-fs runs and the subsequent full 22-suite run passed, so it was not reproduced and remains watched in the next hosted run.
- The local WSL Ubuntu distribution still lacks Node.js and a C++ toolchain, so it was not modified to imitate hosted CI. PR run #470 validated all four native targets; the follow-up run is validating the added package smoke and the Electron-download optimization.

A green Windows run alone does not prove POSIX, and a Linux run alone does not prove Windows or macOS. PR run #470 provides independent successful Electron-target build and security-smoke evidence for all four supported native test targets. The follow-up PR revision makes the afterPack resource/load check part of each native platform gate and skips an unused Electron runtime download in those jobs; its hosted matrix is being rerun. The app currently packages Windows and macOS; Linux remains a supported native backend/test target, not a promise of a Linux release artifact.

The module does not claim to defend against an attacker who already has the same OS identity and can arbitrarily mutate the authorized directory tree or replace the selected root itself. The guarantee is that a path supplied below an opened root cannot escape through path traversal, symlink/junction/reparse traversal, or a path re-resolution race.
