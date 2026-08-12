#!/bin/sh
# One-time setup for abhay.dispatch. Idempotent.
#  1. installs the Cate creds hook (~/.dispatch/cate-creds-hook.zsh + one marked
#     source line appended to ~/.zshrc - nothing else in .zshrc is touched)
#  2. installs the hotkey launcher at ~/.dispatch/bin/dispatch-focus
#  3. npm install + build
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$HOME/.dispatch/bin" "$HOME/.dispatch/cate-cli"

# --- 1. creds hook -----------------------------------------------------------
cat > "$HOME/.dispatch/cate-creds-hook.zsh" <<'EOF'
# abhay.dispatch: export Cate first-party CLI creds so the dispatch server can
# drive terminals (see cate-dispatch/DECISIONS.md #1). Runs only inside Cate
# terminals (CATE_API is set nowhere else). Written by setup.sh; edits are fine.
if [[ -n ${CATE_API:-} && -n ${CATE_TOKEN:-} ]]; then
  () {
    emulate -L zsh
    local f=~/.dispatch/cate-cli/"${PWD//\//%}".json
    print -r -- "{\"api\":\"$CATE_API\",\"token\":\"$CATE_TOKEN\",\"pwd\":\"$PWD\",\"ts\":$(date +%s)}" >| "$f"
    chmod 600 "$f"
  }
fi
EOF

marker='# abhay.dispatch creds hook'
if ! grep -qF "$marker" "$HOME/.zshrc" 2>/dev/null; then
  printf '\n[[ -r ~/.dispatch/cate-creds-hook.zsh ]] && source ~/.dispatch/cate-creds-hook.zsh  %s\n' "$marker" >> "$HOME/.zshrc"
  echo "added creds hook source line to ~/.zshrc"
else
  echo "creds hook already in ~/.zshrc"
fi

# --- 2. hotkey launcher ------------------------------------------------------
cat > "$HOME/.dispatch/bin/dispatch-focus" <<'EOF'
#!/bin/sh
# Focus the Dispatch panel in Cate. Bind this from Raycast / skhd / Shortcuts
# (Cate 1.6.0 has no global shortcut support of its own).
set -eu
cfg="$HOME/.dispatch/server.json"
[ -r "$cfg" ] || { echo "dispatch server not running (no $cfg)" >&2; exit 1; }
port=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$cfg")
secret=$(sed -n 's/.*"secret": *"\([^"]*\)".*/\1/p' "$cfg")
open -a Cate
curl -fsS "http://127.0.0.1:${port}/launcher/focus?secret=${secret}" >/dev/null \
  || echo "dispatch server did not respond (open a Dispatch panel in Cate once)" >&2
EOF
chmod +x "$HOME/.dispatch/bin/dispatch-focus"
echo "installed ~/.dispatch/bin/dispatch-focus"

# --- 3. build ----------------------------------------------------------------
cd "$here"
npm install
npm run build
echo
echo "Done. Next steps:"
echo "  1. Cate → Settings → Extensions → Add local folder… → $here"
echo "  2. Open the Dispatch panel, click 'prove spawn path' (milestone 1)"
echo "  3. Bind ~/.dispatch/bin/dispatch-focus to cmd+shift+d in Raycast/skhd/Shortcuts"
