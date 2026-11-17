#!/bin/bash
# In a webtop container, as abc: put the agy-cli plugin on spec $1.
# One summary line; exit != 0 when anything is off (the caller stops there).
set -u
NEW="$1"
M=/config/.local/bin/magpie
C=/config/.config/magpie

state() { "$M" plugin 2>&1 | grep -E "^ +agy-cli " | sed -E "s/.*\)  //" | head -1; }
spec() {
  "$M" plugin list --json 2>/dev/null | python3 -c 'import json,sys
d = json.load(sys.stdin)
print(next((p["spec"] for p in d.get("plugins", []) if "agy-cli-auth" in p["spec"]), ""))'
}
# newest host: the old one can outlive the restart while it finishes its requests
host() { pgrep -n -f plugin-host/host || true; }

old=$(spec)
before=$(state)
[ -n "$old" ] || { echo "FAIL no agy-cli plugin"; exit 4; }
[ "$old" = "$NEW" ] && { echo "SKIP already $NEW | $before"; exit 0; }

B=$C/backups/pre-agy-fork-$(date +%Y%m%d-%H%M%S)
mkdir -p -m 700 "$B"
for f in plugin-auth.json plugins.json plugins.yml plugin-providers.json plugins/package.json; do
  [ -f "$C/$f" ] && cp -p "$C/$f" "$B/"
done
chmod 600 "$B"/*

h0=$(host)
"$M" plugin rm "$old" >/dev/null 2>&1 || { echo "FAIL rm $old | backup $B"; exit 5; }
if ! "$M" plugin add "$NEW" >/dev/null 2>&1; then
  "$M" plugin add "$old" >/dev/null 2>&1
  echo "FAIL add $NEW, put $old back | backup $B"
  exit 6
fi

now=$(spec)
after=$(state)
# distinct patch markers present (one per patch, however many lines carry it)
p=$(grep -o -e "Video (local patch)" -e "Busy ending (local patch)" -e "Denied ending (local patch)" \
  "$C/plugins/node_modules/@magpie-community/opencode-agy-cli-auth/index.mjs" | sort -u | wc -l | tr -d " ")
h=""
for _ in $(seq 1 60); do
  h=$(host)
  [ -n "$h" ] && [ "$h" != "$h0" ] && break
  sleep 1
done

echo "$old -> $now | $before -> $after | patches=$p | plugin host $h0 -> $h | backup $B"
[ "$now" = "$NEW" ] && [ "$after" = "$before" ] && [ "$p" = 3 ] && [ -n "$h" ] && [ "$h" != "$h0" ] || exit 7
