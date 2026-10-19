/**
 * Validate a mobile public-tunnel hostname in ONE place: config writes,
 * legacy migration, status/probing, and autostart must agree.
 *
 * Only canonical DNS hostnames are allowed. A string like
 * "user@127.0.0.1" is syntactically a URL userinfo prefix, not a harmless
 * display label: interpolation into https://${host}/api/health would probe an
 * unintended destination. No ports, credentials, IP literals, fragments,
 * or query syntax may survive.
 */
import { isIP } from "node:net";

export function normalizeMobileTunnelHost(raw: string): string {
  const input = raw.trim();
  if (!input || /[\u0000-\u0020\u007f@?#%\\]/.test(input)) return "";
  const value = input.replace(/^https?:\/\//i, "");
  if (value.includes("://")) return "";
  const host = value.split("/", 1)[0].toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || isIP(host) !== 0 || !host.includes(".")) return "";
  const labels = host.split(".");
  if (labels.some((label) => label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return "";
  if (labels.at(-1)!.length < 2) return "";
  return host;
}
