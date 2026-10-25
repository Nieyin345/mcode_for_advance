/** An image preview is only valid for the chip path it was loaded from.
 * A passive React effect cannot clear an old image before the first paint
 * of a newly selected chip. Derive the visible result synchronously instead. */
export function visibleTagImage(
  currentPath: string | null | undefined,
  image: { path: string; url: string } | null,
): string | null {
  return currentPath && image?.path === currentPath ? image.url : null;
}
