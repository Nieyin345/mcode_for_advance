let serial = 0;
export function uid(prefix: string): string {
  serial += 1;
  return `${prefix}${serial}`;
}
