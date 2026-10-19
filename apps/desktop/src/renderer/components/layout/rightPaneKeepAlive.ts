/** Mount lazily the first time a right pane is opened, then retain the
 * same subtree across close/reopen. Closing a pane must not restart a
 * file-preview/editor/custom panel. The splitter itself is separate.
 */
export function shouldMountRightPane(rightOpen: boolean, hasOpenedRight: boolean): boolean {
  return rightOpen || hasOpenedRight;
}
