#!/bin/bash
# Builds/refreshes SHIVA.app and "SHIVA HUD.app" in ~/Applications and makes
# relaunch.sh executable. Safe to re-run anytime the launcher scripts change.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/Applications"

osacompile -o "$HOME/Applications/SHIVA.app" "$HERE/shiva-launcher.applescript"
osacompile -o "$HOME/Applications/SHIVA HUD.app" "$HERE/shiva-hud.applescript"

cp "$HERE/shiva.icns" "$HOME/Applications/SHIVA.app/Contents/Resources/applet.icns"
cp "$HERE/shiva.icns" "$HOME/Applications/SHIVA HUD.app/Contents/Resources/applet.icns"
touch "$HOME/Applications/SHIVA.app" "$HOME/Applications/SHIVA HUD.app"

chmod +x "$HERE/../relaunch.sh"
echo "Installed: ~/Applications/SHIVA.app and ~/Applications/SHIVA HUD.app"
