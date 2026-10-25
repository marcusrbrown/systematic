#!/bin/bash

# Git Worktree Manager
# Creates, lists, switches and cleans up Git worktrees under
# <main repository root>/.worktrees/<branch>.
#
# Non-interactive: it never reads stdin. Stdout carries key=value lines (or one
# bare path for switch). Stderr carries prose and `error: <code>: <message>`.
#
# Exit codes: 0 done, 1 environment or git failure, 2 usage error,
# 3 refused (a guard or a user decision is needed).
#
# Bash 3.2 compatible (stock macOS). Keep `set -e` only: no `set -u` (an empty
# "${a[@]}" fails on 3.2). Never pipe into `while`: the pipeline subshell loses
# the arrays the loop builds.

set -e

# A stray GIT_DIR or GIT_WORK_TREE could point git at another repository, so
# the variables that locate a repository are dropped before the first git call.
# LC_ALL=C keeps the git output that is parsed locale-independent.
for _wt_var in GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE \
  GIT_OBJECT_DIRECTORY GIT_NAMESPACE GIT_PREFIX; do
  unset "$_wt_var"
done
unset _wt_var
export LC_ALL=C

TAB=$'\t'

# Prose for humans. Stdout stays machine-readable.
say() {
  printf '%s\n' "$*" >&2
}

# die <exit-code> <code> <message...>
die() {
  local code="$1" tag="$2"
  shift 2
  printf 'error: %s: %s\n' "$tag" "$*" >&2
  exit "$code"
}

# ── Repository root ─────────────────────────────────────────────────────────

MAIN_ROOT=""
WORKTREE_DIR=""

# The main root is the parent of the git common directory, so a run from inside
# a linked worktree still lands at the main checkout. Layouts with no such root
# are refused.
resolve_main_root() {
  local common_raw common superproject root toplevel

  common_raw=$(git rev-parse --git-common-dir 2> /dev/null) ||
    die 1 not-a-repository "not inside a git repository: $PWD"
  common=$(cd "$common_raw" 2> /dev/null && pwd -P) ||
    die 1 git-failure "cannot resolve the git common directory: $common_raw"

  if [ "$(git rev-parse --is-bare-repository 2> /dev/null)" = "true" ] ||
    [ "$(git --git-dir="$common" rev-parse --is-bare-repository 2> /dev/null)" = "true" ]; then
    die 3 unsupported-layout "bare repository (or core.bare) has no main work tree: $common"
  fi
  superproject=$(git rev-parse --show-superproject-working-tree 2> /dev/null) || superproject=""
  if [ -n "$superproject" ]; then
    die 3 unsupported-layout "submodule of $superproject has no main work tree to place .worktrees in"
  fi
  if [ "$(basename "$common")" != ".git" ]; then
    die 3 unsupported-layout "separate git directory $common has no main work tree to place .worktrees in"
  fi

  # A git directory named .git can still belong to a work tree elsewhere
  # (core.worktree), so the inferred root must be its own work tree. Nothing is
  # written before this check.
  root=$(dirname "$common")
  toplevel=$(git -C "$root" rev-parse --show-toplevel 2> /dev/null) || toplevel=""
  toplevel=$(cd "$toplevel" 2> /dev/null && pwd -P) || toplevel=""
  if [ "$toplevel" != "$root" ] ||
    [ "$(git -C "$root" rev-parse --is-bare-repository 2> /dev/null)" = "true" ]; then
    die 3 unsupported-layout "$root is not the work tree of $common; there is no main work tree to place .worktrees in"
  fi

  MAIN_ROOT="$root"
  WORKTREE_DIR="$MAIN_ROOT/.worktrees"
}

# ── Registered worktrees ────────────────────────────────────────────────────

# Read from `git worktree list --porcelain` into parallel arrays. The first
# entry is the main checkout.
WT_PATHS=()
WT_BRANCHES=()
WT_LOCKED=()

load_worktrees() {
  local porcelain line wt_path="" wt_branch="" wt_locked="no"

  porcelain=$(git -C "$MAIN_ROOT" worktree list --porcelain 2> /dev/null) ||
    die 1 git-failure "git worktree list failed in $MAIN_ROOT"

  WT_PATHS=()
  WT_BRANCHES=()
  WT_LOCKED=()

  # The here-string reads a variable, not a pipe, so the arrays survive the
  # loop. The extra newline closes the final record, which $(...) stripped.
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) wt_path="${line#worktree }" ;;
      "branch "*)
        wt_branch="${line#branch }"
        wt_branch="${wt_branch#refs/heads/}"
        ;;
      detached) wt_branch="(detached)" ;;
      locked*) wt_locked="yes" ;;
      "")
        if [ -n "$wt_path" ]; then
          WT_PATHS+=("$wt_path")
          WT_BRANCHES+=("${wt_branch:-(unknown)}")
          WT_LOCKED+=("$wt_locked")
        fi
        wt_path=""
        wt_branch=""
        wt_locked="no"
        ;;
    esac
  done <<< "$porcelain"$'\n'
}

# Prints the name (path relative to .worktrees, for example feat/x) for a path
# under .worktrees, or nothing otherwise.
worktree_name() {
  case "$1" in
    "$WORKTREE_DIR"/*) printf '%s' "${1#"$WORKTREE_DIR"/}" ;;
  esac
}

# True when $1 is the same path as $2 or inside it.
path_within() {
  case "$1" in
    "$2" | "$2"/*) return 0 ;;
  esac
  return 1
}

# Sets FOUND_IDX to the index of the managed worktree called $1, or -1.
find_by_name() {
  local i=0 name
  FOUND_IDX=-1
  while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
    name=$(worktree_name "${WT_PATHS[$i]}")
    if [ -n "$name" ] && [ "$name" = "$1" ]; then
      FOUND_IDX="$i"
      return 0
    fi
    i=$((i + 1))
  done
  return 0
}

# Exit 2 with the managed worktree names on stderr.
unknown_worktree() {
  local i=0 name
  printf 'error: unknown-worktree: no worktree named %s\n' "$1" >&2
  while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
    name=$(worktree_name "${WT_PATHS[$i]}")
    if [ -n "$name" ]; then
      printf '  candidate: %s\n' "$name" >&2
    fi
    i=$((i + 1))
  done
  exit 2
}

# ── Env files and dev tool trust ────────────────────────────────────────────

# Copy the main checkout's git-ignored .env* files into a worktree. Tracked
# files are not ignored, so they are skipped. Symlinks and existing
# destinations are skipped too, and nothing is overwritten or backed up.
copy_env_files() {
  local dest_dir="$1" f name copied=0

  for f in "$MAIN_ROOT"/.env*; do
    name=$(basename "$f")
    if [ -L "$f" ] || [ ! -f "$f" ]; then
      continue
    fi
    if ! git -C "$MAIN_ROOT" check-ignore -q -- "$name"; then
      say "skipped $name (not ignored by git)"
      continue
    fi
    if [ -e "$dest_dir/$name" ] || [ -L "$dest_dir/$name" ]; then
      say "skipped $name (already exists in the worktree)"
      continue
    fi
    cp "$f" "$dest_dir/$name"
    say "copied $name"
    copied=$((copied + 1))
  done
  printf 'copied=%s\n' "$copied"
}

# Auto-trust is only safe when the worktree is created from a long-lived branch
# the developer already controls. Review/PR branches fall back to the default
# branch baseline and require manual direnv approval.
is_trusted_base_branch() {
  local branch="$1" default_branch="$2"

  [ "$branch" = "$default_branch" ] && return 0
  case "$branch" in
    develop | dev | trunk | staging | release/*) return 0 ;;
  esac
  return 1
}

# True when the file is identical to its version at the base ref. Symlinks are
# rejected. A mismatch (added, modified or filtered) means trust is skipped,
# which is the safe direction.
config_unchanged() {
  local file="$1" base_ref="$2" worktree_path="$3" base_hash worktree_hash

  [ -L "$worktree_path/$file" ] && return 1
  base_hash=$(git -C "$MAIN_ROOT" rev-parse "$base_ref:$file" 2> /dev/null) || return 1
  worktree_hash=$(git hash-object "$worktree_path/$file") || return 1
  [ "$base_hash" = "$worktree_hash" ]
}

# Trust mise and direnv configs in a new worktree: these tools have never seen
# the new path and would otherwise block on a prompt. Only configs unchanged
# from the trusted baseline are trusted, and direnv only for trusted bases.
# Stdin is /dev/null so a tool can never wait for an answer.
trust_dev_tools() {
  local worktree_path="$1" base_ref="$2" allow_direnv_auto="$3" f
  local manual=()

  if command -v mise > /dev/null 2>&1; then
    for f in .mise.toml mise.toml .tool-versions; do
      if [ -f "$worktree_path/$f" ]; then
        if config_unchanged "$f" "$base_ref" "$worktree_path"; then
          (cd "$worktree_path" && mise trust "$f" --quiet < /dev/null > /dev/null) ||
            say "mise trust $f failed; run it manually in $worktree_path"
        else
          manual+=("mise trust $f")
        fi
        break
      fi
    done
  fi

  if command -v direnv > /dev/null 2>&1 && [ -f "$worktree_path/.envrc" ]; then
    if [ "$allow_direnv_auto" = "true" ] && config_unchanged ".envrc" "$base_ref" "$worktree_path"; then
      (cd "$worktree_path" && direnv allow < /dev/null > /dev/null) ||
        say "direnv allow failed; run it manually in $worktree_path"
    else
      manual+=("direnv allow")
    fi
  fi

  if [ "${#manual[@]}" -gt 0 ]; then
    say "not auto-trusted (differs from $base_ref or untrusted base); review, then run in $worktree_path: ${manual[*]}"
  fi
}

# ── create ──────────────────────────────────────────────────────────────────

# Sets DEFAULT_BRANCH from origin/HEAD, else from the remote. Never guesses.
DEFAULT_BRANCH=""

resolve_default_branch() {
  local symref line rest

  symref=$(git -C "$MAIN_ROOT" symbolic-ref -q refs/remotes/origin/HEAD 2> /dev/null) || symref=""
  if [ -n "$symref" ]; then
    DEFAULT_BRANCH="${symref#refs/remotes/origin/}"
    return 0
  fi

  line=$(git -C "$MAIN_ROOT" ls-remote --symref origin HEAD < /dev/null 2> /dev/null) || line=""
  while IFS= read -r line; do
    case "$line" in
      "ref: refs/heads/"*)
        rest="${line#ref: refs/heads/}"
        DEFAULT_BRANCH="${rest%%"$TAB"*}"
        break
        ;;
    esac
  done <<< "$line"
  [ -n "$DEFAULT_BRANCH" ] ||
    die 3 base-unresolved "cannot tell origin's default branch; pass --base <ref>"
}

# .worktrees/.gitignore holds `*`, so the directory never shows up in status and
# no tracked file is edited. An existing file is left as it is.
ensure_ignore_file() {
  local ignore="$WORKTREE_DIR/.gitignore"

  if git -C "$MAIN_ROOT" ls-files --error-unmatch -- ".worktrees/.gitignore" > /dev/null 2>&1; then
    say "warning: .worktrees/.gitignore is tracked; leaving it as it is"
    return 0
  fi
  if [ -e "$ignore" ] || [ -L "$ignore" ]; then
    return 0
  fi
  mkdir -p "$WORKTREE_DIR" || die 1 environment "cannot create $WORKTREE_DIR"
  printf '*\n' > "$ignore" || die 1 environment "cannot write $ignore"
}

create_worktree() {
  local branch="" base_arg="" base_ref base_commit worktree_path status_out i

  while [ $# -gt 0 ]; do
    case "$1" in
      --base)
        [ $# -ge 2 ] || die 2 usage "--base needs a ref"
        base_arg="$2"
        shift 2
        ;;
      -*) die 2 usage "unknown option for create: $1" ;;
      *)
        [ -z "$branch" ] || die 2 usage "unexpected argument for create: $1"
        branch="$1"
        shift
        ;;
    esac
  done
  [ -n "$branch" ] || die 2 usage "create needs a branch name"
  git check-ref-format "refs/heads/$branch" 2> /dev/null ||
    die 2 usage "not a valid branch name: $branch"

  resolve_main_root
  worktree_path="$WORKTREE_DIR/$branch"

  if git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    die 3 branch-exists "branch $branch already exists"
  fi
  load_worktrees
  i=0
  while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
    if [ "${WT_PATHS[$i]}" = "$worktree_path" ]; then
      die 3 target-exists "$worktree_path is already a registered worktree"
    fi
    i=$((i + 1))
  done
  if [ -L "$worktree_path" ] || { [ -e "$worktree_path" ] && [ ! -d "$worktree_path" ]; } ||
    { [ -d "$worktree_path" ] && [ -n "$(ls -A "$worktree_path")" ]; }; then
    die 3 target-exists "$worktree_path already exists and is not empty"
  fi

  if [ -n "$base_arg" ]; then
    # Resolved in the caller's checkout, so HEAD means the caller's HEAD.
    base_commit=$(git rev-parse --verify --quiet "$base_arg^{commit}" 2> /dev/null) ||
      die 3 base-unresolved "--base $base_arg does not resolve locally; fetch it first"
    base_ref="$base_arg"
    # Local only: the default branch is needed just to pick the trust baseline.
    DEFAULT_BRANCH=$(git -C "$MAIN_ROOT" symbolic-ref -q refs/remotes/origin/HEAD 2> /dev/null) || DEFAULT_BRANCH=""
    DEFAULT_BRANCH="${DEFAULT_BRANCH#refs/remotes/origin/}"
  else
    resolve_default_branch
    say "fetching origin $DEFAULT_BRANCH"
    if ! status_out=$(git -C "$MAIN_ROOT" fetch --quiet --no-tags origin \
      "+refs/heads/$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH" 2>&1 < /dev/null); then
      die 1 fetch-failed "$(printf '%s\n' "$status_out" | head -n 1); pass --base <ref> to skip the fetch"
    fi
    base_ref="origin/$DEFAULT_BRANCH"
    base_commit="$base_ref"
  fi

  ensure_ignore_file
  say "creating $worktree_path from $base_ref"
  git -C "$MAIN_ROOT" worktree add --quiet --no-track -b "$branch" "$worktree_path" "$base_commit" ||
    die 1 git-failure "git worktree add failed"

  status_out=$(git -C "$MAIN_ROOT" status --porcelain -- .worktrees) ||
    die 1 git-failure "git status failed in $MAIN_ROOT"
  if [ -n "$status_out" ]; then
    die 1 not-ignored ".worktrees shows up in git status after create (worktree left at $worktree_path): $(printf '%s' "$status_out" | head -n 1)"
  fi

  copy_env_files "$worktree_path" > /dev/null
  trust_after_create "$worktree_path" "$base_ref"

  printf 'branch=%s\n' "$branch"
  printf 'base=%s\n' "$base_ref"
  printf 'path=%s\n' "$worktree_path"
}

trust_after_create() {
  local worktree_path="$1" base_ref="$2" base_name trust_branch allow="false"

  if [ -z "$DEFAULT_BRANCH" ]; then
    say "skipping dev tool trust: default branch unknown"
    return 0
  fi
  base_name="${base_ref#origin/}"
  trust_branch="$DEFAULT_BRANCH"
  if is_trusted_base_branch "$base_name" "$DEFAULT_BRANCH"; then
    trust_branch="$base_name"
    allow="true"
  fi
  if git -C "$MAIN_ROOT" rev-parse --verify --quiet "origin/$trust_branch" > /dev/null 2>&1; then
    trust_dev_tools "$worktree_path" "origin/$trust_branch" "$allow"
  else
    say "skipping dev tool trust: origin/$trust_branch not found locally"
  fi
}

# ── list, switch, copy-env ──────────────────────────────────────────────────

# One line per worktree, tab-separated key=value fields. The main checkout is
# listed with name=(main).
list_worktrees() {
  local i=0 name cwd current best=-1 best_len=0
  resolve_main_root
  load_worktrees
  cwd=$(pwd -P)
  # Every linked worktree under .worktrees is also inside the main root, so
  # only the longest path containing the caller is current.
  while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
    if path_within "$cwd" "${WT_PATHS[$i]}" && [ "${#WT_PATHS[$i]}" -gt "$best_len" ]; then
      best="$i"
      best_len="${#WT_PATHS[$i]}"
    fi
    i=$((i + 1))
  done
  i=0
  while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
    name=$(worktree_name "${WT_PATHS[$i]}")
    [ "$i" -eq 0 ] && name="(main)"
    current="no"
    [ "$i" -eq "$best" ] && current="yes"
    printf 'name=%s\tbranch=%s\tcurrent=%s\tpath=%s\n' \
      "${name:--}" "${WT_BRANCHES[$i]}" "$current" "${WT_PATHS[$i]}"
    i=$((i + 1))
  done
}

# Prints the path only. A script cannot change its caller's directory.
switch_worktree() {
  [ -n "$1" ] || die 2 usage "switch needs a worktree name"
  resolve_main_root
  load_worktrees
  find_by_name "$1"
  [ "$FOUND_IDX" -ge 0 ] || unknown_worktree "$1"
  [ -d "${WT_PATHS[$FOUND_IDX]}" ] ||
    die 3 worktree-missing "${WT_PATHS[$FOUND_IDX]} is registered but its directory is gone"
  printf '%s\n' "${WT_PATHS[$FOUND_IDX]}"
}

copy_env_to_worktree() {
  local i=0 cwd best=-1 best_len=0

  resolve_main_root
  load_worktrees
  if [ -n "$1" ]; then
    find_by_name "$1"
    [ "$FOUND_IDX" -ge 0 ] || unknown_worktree "$1"
  else
    cwd=$(pwd -P)
    while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
      if [ -n "$(worktree_name "${WT_PATHS[$i]}")" ] &&
        path_within "$cwd" "${WT_PATHS[$i]}" && [ "${#WT_PATHS[$i]}" -gt "$best_len" ]; then
        best="$i"
        best_len="${#WT_PATHS[$i]}"
      fi
      i=$((i + 1))
    done
    [ "$best" -ge 0 ] || die 2 usage "copy-env needs a worktree name unless run inside one"
    FOUND_IDX="$best"
  fi
  [ -d "${WT_PATHS[$FOUND_IDX]}" ] ||
    die 3 worktree-missing "${WT_PATHS[$FOUND_IDX]} is registered but its directory is gone"
  copy_env_files "${WT_PATHS[$FOUND_IDX]}"
}

# ── cleanup ─────────────────────────────────────────────────────────────────

# Sets C_STATE, C_MOD, C_UNT, C_IGN and C_REASON for the worktree at index $1.
# The first match wins: prunable, current, locked, contains-worktree, dirty,
# detached, clean.
classify() {
  local idx="$1" p="${WT_PATHS[$1]}" status_out row j rc=0

  C_MOD="n/a"
  C_UNT="n/a"
  C_IGN="n/a"
  C_REASON=""

  if [ ! -d "$p" ]; then
    C_STATE="prunable"
    C_REASON="directory is missing; run git worktree prune yourself"
    return 0
  fi

  status_out=$(git -C "$p" status --porcelain=v1 --untracked-files=all 2> /dev/null) || rc=$?
  C_MOD=0
  C_UNT=0
  while IFS= read -r row; do
    case "$row" in
      "") ;;
      "??"*) C_UNT=$((C_UNT + 1)) ;;
      *) C_MOD=$((C_MOD + 1)) ;;
    esac
  done <<< "$status_out"
  C_IGN=$(git -C "$p" ls-files -o -i --exclude-standard --directory 2> /dev/null | wc -l) || C_IGN=0
  C_IGN=$((C_IGN + 0))

  if path_within "$CLEANUP_CWD" "$p"; then
    C_STATE="current"
    C_REASON="your working directory is inside it"
    return 0
  fi
  if [ "${WT_LOCKED[$idx]}" = "yes" ]; then
    C_STATE="locked"
    C_REASON="locked; unlock it first"
    return 0
  fi
  j=0
  while [ "$j" -lt "${#WT_PATHS[@]}" ]; do
    if [ "$j" -ne "$idx" ] && [ "${WT_PATHS[$j]}" != "$p" ] && path_within "${WT_PATHS[$j]}" "$p"; then
      C_STATE="contains-worktree"
      C_REASON="contains another worktree: ${WT_PATHS[$j]}"
      return 0
    fi
    j=$((j + 1))
  done
  if [ "$rc" -ne 0 ] || [ -n "$status_out" ]; then
    C_STATE="dirty"
    C_REASON="modified or untracked files"
    return 0
  fi
  if [ "${WT_BRANCHES[$idx]}" = "(detached)" ]; then
    C_STATE="detached"
    C_REASON="detached HEAD; its commits may be unreachable"
    return 0
  fi
  C_STATE="clean"
}

print_state() {
  local idx="$1"
  printf 'name=%s\tpath=%s\tbranch=%s\tstate=%s\tmodified=%s\tuntracked=%s\tignored=%s\n' \
    "$(worktree_name "${WT_PATHS[$idx]}")" "${WT_PATHS[$idx]}" "${WT_BRANCHES[$idx]}" \
    "$C_STATE" "$C_MOD" "$C_UNT" "$C_IGN"
}

# Report only, unless --remove names worktrees. Only clean ones are removed,
# with plain `git worktree remove`; branches are never deleted.
cleanup_worktrees() {
  local remove_mode=0 names=() name i refused=0 out

  while [ $# -gt 0 ]; do
    case "$1" in
      --remove)
        remove_mode=1
        shift
        while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do
          names+=("$1")
          shift
        done
        ;;
      *) die 2 usage "unknown argument for cleanup: $1" ;;
    esac
  done
  if [ "$remove_mode" -eq 1 ] && [ "${#names[@]}" -eq 0 ]; then
    die 2 usage "--remove needs at least one worktree name"
  fi

  resolve_main_root
  load_worktrees
  CLEANUP_CWD=$(pwd -P)

  if [ "$remove_mode" -eq 0 ]; then
    i=1
    while [ "$i" -lt "${#WT_PATHS[@]}" ]; do
      if [ -n "$(worktree_name "${WT_PATHS[$i]}")" ]; then
        classify "$i"
        print_state "$i"
      fi
      i=$((i + 1))
    done
    return 0
  fi

  # Unknown names fail before anything is removed.
  for name in "${names[@]}"; do
    find_by_name "$name"
    [ "$FOUND_IDX" -ge 0 ] || unknown_worktree "$name"
  done

  for name in "${names[@]}"; do
    find_by_name "$name"
    i="$FOUND_IDX"
    classify "$i"
    if [ "$C_STATE" = "clean" ]; then
      if out=$(git -C "$MAIN_ROOT" worktree remove "${WT_PATHS[$i]}" 2>&1 < /dev/null); then
        printf 'result=removed\tname=%s\tpath=%s\n' "$name" "${WT_PATHS[$i]}"
        continue
      fi
      C_STATE="refused-by-git"
      C_REASON=$(printf '%s\n' "$out" | head -n 1)
    fi
    refused=1
    printf 'result=refused\tname=%s\tstate=%s\tignored=%s\treason=%s\n' "$name" "$C_STATE" "$C_IGN" "$C_REASON"
  done
  [ "$refused" -eq 0 ] || exit 3
}

# ── Entry point ─────────────────────────────────────────────────────────────

show_help() {
  cat << 'EOF'
Git Worktree Manager

Worktrees live at <main repository root>/.worktrees/<branch>. The script never
reads stdin and never changes your directory.

Usage: worktree-manager.sh <command> [options]

Commands:
  create <branch> [--base <ref>]  New branch and worktree. Without --base it
                                  fetches origin's default branch and branches
                                  from origin/<default>. --base uses a local
                                  ref and does not fetch. Last stdout lines:
                                  branch=, base=, path=.
  list | ls                       One line per worktree.
  switch | go <name>              Print the worktree's path. It cannot change
                                  the caller's directory: run commands with
                                  that path as the working directory.
  copy-env | env [name]           Copy git-ignored .env* files from the main
                                  checkout. Never overwrites. Without a name,
                                  uses the worktree you are inside.
  cleanup | clean                 Report each worktree under .worktrees with
                                  state, modified, untracked and ignored counts.
  cleanup --remove <name>...      Remove the named worktrees that are clean.
                                  Removal deletes their ignored files (.env,
                                  node_modules). Other states are refused.
                                  Branches are never deleted.
  help                            Show this help.

Exit codes: 0 ok, 1 error, 2 usage, 3 refused (needs a decision).
Errors print `error: <code>: <message>` on stderr.
EOF
}

main() {
  local command="${1:-list}"
  [ $# -eq 0 ] || shift

  case "$command" in
    create) create_worktree "$@" ;;
    list | ls) list_worktrees ;;
    switch | go) switch_worktree "$1" ;;
    copy-env | env) copy_env_to_worktree "$1" ;;
    cleanup | clean) cleanup_worktrees "$@" ;;
    help | -h | --help) show_help ;;
    *)
      show_help >&2
      die 2 usage "unknown command: $command"
      ;;
  esac
}

main "$@"
