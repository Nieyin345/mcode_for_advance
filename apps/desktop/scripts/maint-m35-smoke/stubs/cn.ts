/** cn() 桩：只做空格拼接,不起真实的 clsx/tailwind-merge。判据看的是类名里有没有某个
 *  token(如 `group-focus-within:flex`),拼接顺序无关。 */
export function cn(...inputs: unknown[]): string {
  return inputs.filter((x): x is string => typeof x === "string" && x.length > 0).join(" ");
}
