#!/bin/sh
# Remove Muse for Linux (installed by install.sh) for the current user.
# Your Muse session/profile data lives in ~/.config/Muse (the app's
# Electron profile); this script leaves it in place on purpose.
set -e

rm -rf "$HOME/.local/share/muse-linux"
rm -f "$HOME/.local/share/applications/muse.desktop"
rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/muse.png"

# Scrub the default-handler entries install.sh registered, so
# they do not dangle at a desktop file that no longer exists.
MIMEAPPS="$HOME/.config/mimeapps.list"
if [ -f "$MIMEAPPS" ]; then
  sed -i \
    -e '/^x-scheme-handler\/hatch=muse\.desktop$/d' \
    -e '/^x-scheme-handler\/endo-window=muse\.desktop$/d' \
    -e '/^x-scheme-handler\/muse=muse\.desktop$/d' \
    "$MIMEAPPS"
fi

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$HOME/.local/share/applications" || true

echo "Muse for Linux removed."
echo "Your login and settings were left in ~/.config/Muse - delete that folder too for a completely clean slate."
