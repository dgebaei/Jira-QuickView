#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 1 ]; then
  echo "Usage: scripts/build-extension-and-reload.sh [worktree-path]" >&2
  exit 1
fi

current_worktree_root="$(git rev-parse --show-toplevel)"
git_common_dir="$(git rev-parse --git-common-dir)"
repo_root="$(dirname "$git_common_dir")"
target_worktree="${1:-$current_worktree_root}"

if [ ! -d "$target_worktree/jira-plugin" ]; then
  echo "Could not find jira-plugin in: $target_worktree" >&2
  exit 1
fi

active_extension_root="$repo_root/.worktrees/_active-extension_/jira-plugin"

echo "Building extension from: $target_worktree"
npx webpack --mode=development --config "$target_worktree/webpack.config.js"

rm -rf "$active_extension_root"
mkdir -p "$active_extension_root"

cp "$target_worktree/jira-plugin/manifest.json" "$active_extension_root/manifest.json"
cp -R "$target_worktree/jira-plugin/build" "$active_extension_root/build"
cp -R "$target_worktree/jira-plugin/options" "$active_extension_root/options"
cp -R "$target_worktree/jira-plugin/resources" "$active_extension_root/resources"

echo "Active unpacked extension updated at: $active_extension_root"
echo "Refresh this extension in chrome://extensions"
