/**
 * Scope a sql.js prepared statement to one synchronous read operation.
 *
 * sql.js statements hold native/asm allocations. A bind/step/getAsObject
 * failure must never skip free(), nor be silently turned into an empty result.
 * Keep business meaning and errors with the caller; this helper owns only the
 * resource lifetime. Prepare errors occur before there is a statement to free.
 */
export function withStatement<T extends { free(): void }, R>(
  statement: T,
  read: (statement: T) => R,
): R {
  try {
    return read(statement);
  } finally {
    statement.free();
  }
}
