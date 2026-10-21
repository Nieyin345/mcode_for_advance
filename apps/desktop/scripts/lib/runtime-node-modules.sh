#!/usr/bin/env bash
# Link a temporary Node bundle to the *existing* desktop dependencies.
# Source this helper from a smoke run.sh after cd to apps/desktop.
# ESM ignores NODE_PATH; a real directory link is required for runtime imports.
mcode_link_runtime_node_modules() {
  if [[ "$#" -ne 2 ]]; then
    echo "runtime-node-modules: expected OUT and source node_modules" >&2
    return 1
  fi
  local out="$1" modules="$2" link="$1/node_modules"
  if [[ ! -d "$out" || ! -d "$modules" ]]; then
    echo "runtime-node-modules: output or source directory missing" >&2
    return 1
  fi
  if [[ -e "$link" || -L "$link" ]]; then
    echo "runtime-node-modules: refusing to replace existing $link" >&2
    return 1
  fi

  case "$(uname -s)" in
    MSYS*|MINGW*|CYGWIN*)
      # MSYS ln -s may fail with EBUSY when creating a Windows directory link.
      # Native Node creates an NTFS junction without administrator symlink rights.
      # Convert *both* paths: native node.exe cannot interpret MSYS /tmp paths.
      local source_native link_native
      if command -v cygpath >/dev/null 2>&1; then
        source_native="$(cygpath -wa "$modules")" || return 1
        link_native="$(cygpath -wa "$link")" || return 1
      else
        # Git Bash distributions without cygpath commonly provide pwd -W.
        source_native="$(cd "$modules" && pwd -W)" || return 1
        link_native="$(cd "$out" && printf '%s/node_modules' "$(pwd -W)")" || return 1
      fi
      node scripts/lib/runtime-node-modules.cjs "$source_native" "$link_native"
      ;;
    *)
      # POSIX symlinks continue to use the original behavior.
      ln -s "$modules" "$link"
      ;;
  esac
}
