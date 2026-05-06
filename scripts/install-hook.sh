#!/usr/bin/env bash
#
# install-hook.sh — install/uninstall the deadlint global git pre-push hook.
#
# Sets git's global core.hooksPath and writes a pre-push script there.
# Once installed, every `git push` from any repo on this machine runs
# `deadlint --check dead-rpc` first and aborts the push on findings.
#
# Usage:
#   install-hook.sh install [--force]
#   install-hook.sh uninstall
#   install-hook.sh status
#
# Exit codes:
#   0  ok
#   1  refused (existing hook, etc.) — re-run with --force or fix manually
#   2  bad arguments

set -euo pipefail

HOOKS_DIR="${DEADLINT_HOOKS_DIR:-$HOME/.config/git/hooks}"
HOOK_FILE="$HOOKS_DIR/pre-push"
MARKER="# deadlint-managed: pre-push hook (v1)"

usage() {
  cat <<EOF
deadlint hook installer

USAGE
  install-hook.sh install [--force]
  install-hook.sh uninstall
  install-hook.sh status

WHAT IT DOES
  install     Sets git config --global core.hooksPath to "$HOOKS_DIR" and
              writes a pre-push hook there. Refuses if a non-deadlint
              pre-push hook already exists; pass --force to overwrite.

  uninstall   Removes the deadlint pre-push hook (only if we wrote it).
              Leaves core.hooksPath alone so other hooks keep working.

  status      Prints whether the hook is installed and what core.hooksPath
              is currently set to.

ENVIRONMENT
  DEADLINT_HOOKS_DIR   Override the hooks dir (default: ~/.config/git/hooks)
EOF
}

is_managed_by_us() {
  [ -f "$HOOK_FILE" ] && grep -q "$MARKER" "$HOOK_FILE" 2>/dev/null
}

cmd_status() {
  echo "deadlint hook status"
  echo "  hooks dir:        $HOOKS_DIR"
  local current
  current="$(git config --global --get core.hooksPath || true)"
  if [ -z "$current" ]; then
    echo "  core.hooksPath:   (unset)"
  else
    echo "  core.hooksPath:   $current"
  fi
  if [ -f "$HOOK_FILE" ]; then
    if is_managed_by_us; then
      echo "  pre-push hook:    installed (deadlint-managed)"
    else
      echo "  pre-push hook:    present, but NOT managed by deadlint"
    fi
  else
    echo "  pre-push hook:    not present"
  fi
}

cmd_install() {
  local force=0
  if [ "${1:-}" = "--force" ]; then force=1; fi

  mkdir -p "$HOOKS_DIR"

  if [ -f "$HOOK_FILE" ] && [ "$force" -eq 0 ]; then
    if is_managed_by_us; then
      echo "deadlint pre-push hook is already installed at $HOOK_FILE"
      echo "Pass --force to reinstall (e.g. to upgrade)."
      return 0
    else
      cat >&2 <<EOF
deadlint refuses to overwrite an existing hook.

  Existing file: $HOOK_FILE
  This file does NOT contain the deadlint marker, so it was put there
  by something else (you, husky, lefthook, or an old install).

Options:
  1. Pass --force to overwrite it. The previous hook will be lost.
  2. Move/edit it yourself, then re-run install-hook install.
  3. Use a different hooks dir: DEADLINT_HOOKS_DIR=/other/path install-hook install
EOF
      return 1
    fi
  fi

  cat > "$HOOK_FILE" <<'HOOK'
#!/usr/bin/env bash
# deadlint-managed: pre-push hook (v1)
#
# Runs `deadlint --check dead-rpc` on the current repo before each push.
# Aborts the push on findings. Skips silently if deadlint isn't installed
# or the repo isn't TypeScript.
#
# Bypass once: git push --no-verify
# Uninstall:   deadlint --uninstall-hook
#
# This file is overwritten by `deadlint --install-hook --force`. If you
# need to customize, copy it to ~/.config/git/hooks/pre-push.local and
# remove the deadlint marker line above so it isn't re-managed.

set -e

if ! command -v deadlint >/dev/null 2>&1; then
  exit 0
fi

# Skip non-TS repos quickly. Look for a tsconfig in common spots.
if [ ! -f tsconfig.json ] \
  && [ ! -f apps/worker/tsconfig.json ] \
  && [ ! -f tsconfig.base.json ]; then
  exit 0
fi

echo "→ deadlint scan…"
if ! deadlint . --check dead-rpc; then
  cat >&2 <<MSG

deadlint found dead RPC methods. Re-run for full output:
  deadlint .

To bypass once:
  git push --no-verify

To remove this hook entirely:
  deadlint --uninstall-hook
MSG
  exit 1
fi
HOOK

  chmod +x "$HOOK_FILE"

  # Set core.hooksPath only if it isn't already pointing at us
  local current
  current="$(git config --global --get core.hooksPath || true)"
  if [ "$current" != "$HOOKS_DIR" ]; then
    if [ -n "$current" ] && [ "$force" -eq 0 ]; then
      cat >&2 <<EOF
deadlint installed the pre-push hook at $HOOK_FILE
  but did NOT change git's global core.hooksPath, because it's already
  set to: $current

  Either:
    1. Move your hooks into $HOOKS_DIR
    2. Re-run with --force to overwrite core.hooksPath
    3. Set core.hooksPath manually if you have a custom setup
EOF
    else
      git config --global core.hooksPath "$HOOKS_DIR"
      echo "Set git config --global core.hooksPath to $HOOKS_DIR"
    fi
  fi

  echo "✓ deadlint pre-push hook installed at $HOOK_FILE"
}

cmd_uninstall() {
  if [ ! -f "$HOOK_FILE" ]; then
    echo "Nothing to do — no hook found at $HOOK_FILE"
    return 0
  fi

  if ! is_managed_by_us; then
    cat >&2 <<EOF
deadlint refuses to remove a hook it didn't install.

  $HOOK_FILE exists but does not contain the deadlint marker.
  Remove it manually if you want it gone.
EOF
    return 1
  fi

  rm -- "$HOOK_FILE"
  echo "✓ removed deadlint pre-push hook at $HOOK_FILE"
  echo "  (left git config --global core.hooksPath unchanged so any other"
  echo "   hooks in $HOOKS_DIR keep working)"
}

case "${1:-}" in
  install)   shift; cmd_install "$@" ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  status)    shift; cmd_status "$@" ;;
  -h|--help|help|"") usage ;;
  *) echo "unknown command: $1" >&2; usage; exit 2 ;;
esac
