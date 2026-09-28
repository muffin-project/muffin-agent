#!/usr/bin/env bash
# The root-executed installer must be identified immutably: the bootstrap
# fetches install.sh by committed SHA, passes MUFFIN_REF down, and refuses a
# ref that is not a 40-hex commit. Deterministic: `curl` is stubbed, no network.
set -euo pipefail

REPO=${1:-$(git rev-parse --show-toplevel)}
REPO=$(cd "$REPO" && pwd)
LAB=$(mktemp -d /tmp/muffin-immutable-ref.XXXXXX)
trap 'rm -rf -- "$LAB"' EXIT HUP INT TERM

mkdir -p "$LAB/bin" "$LAB/tmp"
cat >"$LAB/bin/curl" <<'STUB'
#!/bin/sh
# Record the URL, then stage a fake installer at the -o target.
printf '%s\n' "$@" >>"$CURL_LOG"
out=
prev=
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out=$arg; fi
  prev=$arg
done
case "$out" in
  "") exit 1 ;;
  *) printf '%s\n' '#!/bin/sh' 'printf "installer: ref=%s\\n" "${MUFFIN_REF:-}"' >"$out" ;;
esac
STUB
chmod 0755 "$LAB/bin/curl"

SHA=0123456789abcdef0123456789abcdef01234567

# 1. A pinned ref is fetched by SHA and passed down.
set +e
CURL_LOG="$LAB/url.log" MUFFIN_REF="$SHA" TMPDIR="$LAB/tmp" \
  PATH="$LAB/bin:/usr/bin:/bin" sh "$REPO/bootstrap.sh" >"$LAB/ok.log" 2>&1
ok_rc=$?
set -e
if [ "$ok_rc" -ne 0 ]; then
  cat "$LAB/ok.log" >&2
  echo "immutable-ref eval: bootstrap failed on a pinned ref" >&2
  exit 1
fi
if ! grep -Fq "https://raw.githubusercontent.com/muffin-project/muffin-agent/$SHA/install.sh" "$LAB/url.log"; then
  cat "$LAB/url.log" >&2
  echo "immutable-ref eval: the installer was not fetched by committed SHA" >&2
  exit 1
fi
if ! grep -Fq "installer: ref=$SHA" "$LAB/ok.log"; then
  cat "$LAB/ok.log" >&2
  echo "immutable-ref eval: MUFFIN_REF did not reach the installer" >&2
  exit 1
fi

# 2. A ref that is not a commit SHA is refused before any fetch.
set +e
: >"$LAB/url2.log"
CURL_LOG="$LAB/url2.log" MUFFIN_REF=main TMPDIR="$LAB/tmp" \
  PATH="$LAB/bin:/usr/bin:/bin" sh "$REPO/bootstrap.sh" >"$LAB/bad.log" 2>&1
bad_rc=$?
set -e
if [ "$bad_rc" -eq 0 ] || [ -s "$LAB/url2.log" ]; then
  cat "$LAB/bad.log" >&2
  echo "immutable-ref eval: a mutable ref was accepted (or fetched before refusal)" >&2
  exit 1
fi

# 3. The installer itself: a pinned ref is accepted, a mutable one refused
# with its own message (and never "die: not found").
set +e
MUFFIN_REF="$SHA" sh "$REPO/install.sh" --paths >"$LAB/installer-ok.log" 2>&1
installer_ok_rc=$?
set -e
if [ "$installer_ok_rc" -ne 0 ] || grep -Fq 'die: not found' "$LAB/installer-ok.log"; then
  cat "$LAB/installer-ok.log" >&2
  echo "immutable-ref eval: installer refused a valid pinned ref" >&2
  exit 1
fi
set +e
MUFFIN_REF=main sh "$REPO/install.sh" --paths >"$LAB/installer-bad.log" 2>&1
installer_bad_rc=$?
set -e
if [ "$installer_bad_rc" -eq 0 ] || ! grep -Fq 'commit SHA' "$LAB/installer-bad.log" || grep -Fq 'die: not found' "$LAB/installer-bad.log"; then
  cat "$LAB/installer-bad.log" >&2
  echo "immutable-ref eval: installer did not refuse a mutable ref cleanly" >&2
  exit 1
fi

echo "immutable-ref eval: PASS — installer fetched by committed SHA, pinned ref passed down, mutable ref refused"
