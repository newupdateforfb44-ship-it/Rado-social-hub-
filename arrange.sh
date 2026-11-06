#!/usr/bin/env bash
# Rado Social Hub - arrange the repo and push to GitHub.
# Run from the Codespace terminal:   bash arrange.sh
set -e

cd "$(git rev-parse --show-toplevel)"
echo "==> Repo: $(pwd)"

echo "==> Getting the latest files from GitHub..."
git pull --rebase --autostash || echo "(pull skipped)"

# If the files were uploaded inside a sub-folder, bring them up to the root first.
if [ ! -f server.js ] && [ -f Rado-social-hub--main/server.js ]; then
  echo "==> Moving files out of Rado-social-hub--main/ to the root..."
  shopt -s dotglob nullglob
  mv Rado-social-hub--main/* .
  shopt -u dotglob nullglob
  rmdir Rado-social-hub--main 2>/dev/null || true
fi

if [ ! -f server.js ]; then
  echo "ERROR: server.js not found. Upload the files to the repo first, then run again."
  exit 1
fi

# move <file> <destination-path>  (skips quietly if the file is not there)
move() {
  local src="$1" dest="$2"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    mv -f "$src" "$dest"
    echo "  $src -> $dest"
  fi
}

echo "==> Fixing file names..."
move "1.gitignore" ".gitignore"
move "1.npmrc"     ".npmrc"
# Empty placeholder files -> keep the upload folders in Git
move "1.gitkeep"      "public/uploads/.gitkeep"
move "gitkeep (1)"    "public/receipts/.gitkeep"
move "gitkeep (2)"    "public/files/.gitkeep"
# Duplicate copies ("... (1).png") - identical to the originals, so remove them
rm -f "rado-icon-192 (1).png" "rado-icon-512 (1).png" "rado-maskable-512 (1).png"

echo "==> Server modules -> lib/"
for f in benotp brand-logos campaigns countries engagement extras flw-methods fx geo \
         global-payments korapay mailer minipdf mysql opaque-ref ops platform \
         rado-upgrade settings welcomepopup; do
  move "$f.js" "lib/$f.js"
done
move "countries.data.json" "lib/countries.data.json"

echo "==> Customer pages + their files -> public/rado/"
for f in login register dashboard products sms deposit fund-crypto transactions orders profile api-access; do
  move "$f.html" "public/rado/$f.html"
done
move "rado.js"       "public/rado/rado.js"
move "rado.css"      "public/rado/rado.css"
move "rado-logo.png" "public/rado/rado-logo.png"

echo "==> Admin page, icons, manifest -> public/"
move "admin.html"          "public/admin.html"
move "manifest.json"       "public/manifest.json"
move "robots.txt"          "public/robots.txt"
move "favicon.png"         "public/favicon.png"
move "favicon-32.png"      "public/favicon-32.png"
move "apple-touch-icon.png" "public/apple-touch-icon.png"
move "theme.css"           "public/theme.css"
move "style.css"           "public/style.css"
move "script.js"           "public/script.js"
move "welcome-popup.js"    "public/welcome-popup.js"

echo "==> App icons -> public/img/"
move "rado-icon-192.png"     "public/img/rado-icon-192.png"
move "rado-icon-512.png"     "public/img/rado-icon-512.png"
move "rado-maskable-512.png" "public/img/rado-maskable-512.png"

echo "==> Browser scripts -> public/js/"
for f in announcements app-guide app-shell auth-keeper back-button country-select dev-credit \
         extras-customer global-pay i18n live-support money ops-admin rado-brand \
         rado-select-sheet rado-ui rsh-menu-guard rsh-ui wallet; do
  move "$f.js" "public/js/$f.js"
done

echo "==> Stylesheets -> public/css/"
for f in admin-customer-theme admin-pro layout-polish marketplace-standard mobile-fix rado-brand \
         rado-final rado-glass-ui rado-mobile-polish rado-theme rado-ui redesign \
         responsive-device-fit rsh-ui-fixes; do
  move "$f.css" "public/css/$f.css"
done

echo "==> Saving to GitHub..."
# This script has done its job - remove it so it is not left in the repo.
rm -f arrange.sh
git add -A
if git diff --cached --quiet; then
  echo "Nothing to change - already arranged."
else
  git commit -m "Arrange project into lib/ and public/ folders, fix file names"
  git push
  echo "==> Done. Refresh GitHub - the files are now arranged."
fi
