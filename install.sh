#!/bin/sh
# Install Muse for Linux (prebuilt) into ~/.local for the current user.
set -e
cd "$(dirname "$0")"

DEST="$HOME/.local/share/muse-linux"
mkdir -p "$DEST" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/256x256/apps"

if [ -d "Muse-linux-x64" ]; then
  SRC="Muse-linux-x64"
elif [ -f "Muse-linux-x64.zip" ]; then
  TMP="$(mktemp -d)"
  unzip -q "Muse-linux-x64.zip" -d "$TMP"
  SRC="$TMP/Muse-linux-x64"
else
  echo "Run npm run package first, or place Muse-linux-x64.zip next to this script." >&2
  exit 1
fi

rm -rf "$DEST"
cp -r "$SRC" "$DEST"
chmod +x "$DEST/Muse"
cp "src/icon.png" "$HOME/.local/share/icons/hicolor/256x256/apps/muse.png"

cat > "$HOME/.local/share/applications/muse.desktop" <<EOF
[Desktop Entry]
Name=Muse
Comment=Muse - personal AI assistant (unofficial Linux port)
Exec=$DEST/Muse %U
Icon=muse
Terminal=false
Type=Application
Categories=Productivity;Utility;
StartupWMClass=Muse
MimeType=x-scheme-handler/hatch;x-scheme-handler/endo-window;x-scheme-handler/muse;
EOF

# Register the desktop entry and the deep-link schemes (best effort:
# not every desktop environment ships these tools).
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$HOME/.local/share/applications" || true
if command -v xdg-mime >/dev/null 2>&1; then
  for scheme in hatch endo-window muse; do
    xdg-mime default muse.desktop "x-scheme-handler/$scheme" || true
  done
fi

echo "Installed to $DEST"
echo "Launch 'Muse' from your applications menu, or run: $DEST/Muse"
echo "Closing the window keeps Muse in the system tray; Quit is in the tray menu."
