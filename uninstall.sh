#!/bin/sh
# Remove Muse for Linux (installed by install.sh) for the current user.
# Your Muse session/profile data lives in ~/.config/muse-linux (Electron
# userData under the package name); remove it too if you want a clean slate.
set -e

rm -rf "$HOME/.local/share/muse-linux"
rm -f "$HOME/.local/share/applications/muse.desktop"
rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/muse.png"

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$HOME/.local/share/applications" || true

echo "Muse for Linux removed."
echo "Profile/session data was left in place (check ~/.config for a muse-linux or Muse folder if you want to delete it)."
