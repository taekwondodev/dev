#!/bin/sh
set -eu

manifest_url=https://raw.githubusercontent.com/taekwondodev/dev/main/package.json
pi_installer_url=https://pi.dev/install.sh
extensions='dev-footer dev-header dev-hush terminal-status-title'
bridge=npm:pi-claude-bridge

git_base=${DEV_INSTALL_GIT_BASE:-https://github.com/taekwondodev}
destination=${DEV_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/dev}
skills_dir=$HOME/.agents/skills
pi_bin=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin
completed=
work=
staging=
case $destination in
  /*) ;;
  *) destination=$PWD/$destination ;;
esac

say() {
  printf '%s\n' "$*"
}

step() {
  printf '\n==> %s\n' "$*"
}

record() {
  completed="$completed
  - $*"
}

fail() {
  printf '\ndev install stopped: %s\n' "$*" >&2
  if [ -n "$completed" ]; then
    printf 'Already done:%s\n' "$completed" >&2
    printf 'Finish the remaining steps by hand, in the order main runs them in https://github.com/taekwondodev/dev/blob/main/scripts/install.sh\n' >&2
  fi
  exit 1
}

run() {
  label=$1
  shift
  "$@" || fail "$label failed."
}

version_at_least() {
  awk -v have="$1" -v need="$2" 'BEGIN {
    split(have, h, "."); split(need, n, ".")
    for (i = 1; i <= 3; i++) {
      if (h[i] + 0 > n[i] + 0) exit 0
      if (h[i] + 0 < n[i] + 0) exit 1
    }
    exit 0
  }'
}

writable_or_creatable() {
  dir=$1
  while [ ! -e "$dir" ]; do
    dir=$(dirname "$dir")
  done
  [ -d "$dir" ] && [ -w "$dir" ]
}

has_terminal() {
  ( : <>/dev/tty ) 2>/dev/null
}

check_prerequisites() {
  step 'Checking prerequisites'
  problems=
  if [ "$(uname -s)" != Darwin ]; then
    problems="$problems
  - This installer supports macOS only."
  fi

  manifest=$(curl -fsSL "$manifest_url") || fail "cannot read dev's package.json from $manifest_url. Check the network connection and run the installer again. Nothing was changed."
  node_minimum=$(printf '%s\n' "$manifest" | sed -n 's/^ *"node": *">=\([0-9][0-9.]*\)".*/\1/p')
  [ -n "$node_minimum" ] || fail "dev's package.json does not state its Node minimum as \">=VERSION\", so this installer cannot check Node. Nothing was changed."
  if ! command -v node >/dev/null 2>&1; then
    problems="$problems
  - Node $node_minimum or newer is missing. Install it from https://nodejs.org/en/download or with: brew install node"
  else
    node_version=$(node --version)
    node_version=${node_version#v}
    case $node_version in
      *-*) node_supported=false ;;
      *) version_at_least "$node_version" "$node_minimum" && node_supported=true || node_supported=false ;;
    esac
    if [ "$node_supported" = false ]; then
      problems="$problems
  - Node $node_minimum or newer, as a stable release, is required, found $node_version. Update it from https://nodejs.org/en/download or with: brew upgrade node"
    fi
    if ! npm_prefix=$(npm_config_cache="$work/npm-cache" npm_config_logs_dir="$work/npm-logs" npm prefix -g 2>/dev/null) || [ -z "$npm_prefix" ]; then
      problems="$problems
  - npm is missing or cannot report its global prefix. npm ships with Node: reinstall Node from https://nodejs.org/en/download or with: brew install node"
    elif ! writable_or_creatable "$npm_prefix/lib/node_modules" || ! writable_or_creatable "$npm_prefix/bin"; then
      problems="$problems
  - npm cannot link the dev command without sudo, because its global prefix $npm_prefix is not writable. Use Node from Homebrew (brew install node), or give npm a prefix you own: npm config set prefix ~/.local, then add ~/.local/bin to PATH."
    fi
  fi

  if ! xcode-select -p >/dev/null 2>&1; then
    problems="$problems
  - The Xcode Command Line Tools are missing. Install them with: xcode-select --install"
  fi
  if ! command -v git >/dev/null 2>&1; then
    problems="$problems
  - git is missing. It comes with the Xcode Command Line Tools: xcode-select --install"
  fi

  if [ -e "$destination" ] || [ -L "$destination" ]; then
    problems="$problems
  - $destination already exists. This installer sets up a new Mac only. To update an existing dev checkout, run npm run update in it; to install elsewhere, set DEV_DIR to a new path."
  fi

  [ -z "$problems" ] || fail "fix these and run the installer again. Nothing was changed.$problems"
}

run_pi_installer() {
  pi_failed=$work/pi-installer-failed
  ( sh "$1" || : >"$pi_failed" ) | cat
  [ ! -e "$pi_failed" ]
}

install_pi() {
  step 'Installing the latest Pi with the pi.dev installer'
  run "Downloading the Pi installer from $pi_installer_url" curl -fsSL "$pi_installer_url" -o "$work/pi-install.sh"
  run 'The Pi installer' run_pi_installer "$work/pi-install.sh"
  [ -x "$pi_bin/pi" ] || fail "the Pi installer finished, but $pi_bin/pi is missing. Install Pi from https://pi.dev, then run the remaining steps by hand, in the order main runs them in https://github.com/taekwondodev/dev/blob/main/scripts/install.sh."
  PATH=$pi_bin:$PATH
  export PATH
  record "Pi installed, run as $pi_bin/pi"
}

install_dev() {
  step "Cloning dev into $destination"
  mkdir -p "$(dirname "$destination")"
  run "git clone of $git_base/dev" git clone --branch main "$git_base/dev" "$destination"
  record "dev cloned into $destination"
  cd "$destination"

  step 'Installing dev'
  run 'npm ci --ignore-scripts' npm ci --ignore-scripts
  run 'npm run setup' npm run setup
  run 'npm link --ignore-scripts' npm link --ignore-scripts
  record 'dev set up and the dev command linked'
}

install_extensions() {
  step 'Installing extensions as Pi packages'
  for extension in $extensions; do
    run "pi install git:github.com/taekwondodev/$extension" pi install "git:github.com/taekwondodev/$extension"
    record "Pi package git:github.com/taekwondodev/$extension installed"
  done
}

offer_bridge() {
  step "Optional: $bridge"
  if ! has_terminal; then
    say "No terminal to ask, so $bridge was not installed. Install it later with: pi install $bridge"
    return 0
  fi
  printf 'Install %s? It lets Pi use Claude through Claude Code and runs Claude Code with its own configuration in every Pi session, see https://github.com/taekwondodev/dev/blob/main/SECURITY.md [y/N] ' "$bridge" >/dev/tty
  IFS= read -r answer </dev/tty || answer=
  case $answer in
    y | Y | yes | Yes | YES)
      run "pi install $bridge" pi install "$bridge"
      record "Pi package $bridge installed"
      ;;
    *)
      say "Skipped $bridge. Install it later with: pi install $bridge"
      ;;
  esac
}

install_skills() {
  step "Copying the skill library into $skills_dir"
  run "git clone of $git_base/skills" git clone --quiet --depth 1 --branch main "$git_base/skills" "$work/skills"
  library=$work/skills/skills
  collisions=
  for entry in "$library"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    if [ -e "$skills_dir/$name" ] || [ -L "$skills_dir/$name" ]; then
      collisions="$collisions $name"
    fi
  done
  if [ -n "$collisions" ]; then
    say "Skipped the whole skill library: $skills_dir already has entries with these names:$collisions"
    say "No skill was copied and your entries are unchanged. Copy the library from $git_base/skills by hand once the names no longer collide."
    return 0
  fi
  mkdir -p "$skills_dir"
  staging=$(mktemp -d "$skills_dir/.dev-install.XXXXXX")
  for entry in "$library"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    cp -R "$entry" "$staging/" || fail "copying the skill library into $skills_dir failed. No skill was installed and your entries are unchanged."
  done
  published=$work/published
  : >"$published"
  for entry in "$staging"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name=${entry##*/}
    if ! mv "$entry" "$skills_dir/"; then
      while IFS= read -r installed; do
        [ -n "$installed" ] && rm -rf "${skills_dir:?}/$installed"
      done <"$published"
      fail "moving the skill library into $skills_dir failed. No skill was installed and your entries are unchanged."
    fi
    printf '%s\n' "$name" >>"$published"
  done
  rmdir "$staging"
  staging=
  record "skill library copied into $skills_dir"
}

cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
  if [ -n "$staging" ]; then rm -rf "$staging"; fi
}

main() {
  trap cleanup EXIT
  work=$(mktemp -d "${TMPDIR:-/tmp}/dev-install.XXXXXX")
  check_prerequisites
  install_pi
  install_dev
  install_extensions
  offer_bridge
  install_skills
  step 'dev is installed'
  say "Checkout: $destination"
  case :$PATH: in
    *":$npm_prefix/bin:"*) ;;
    *) say "Add $npm_prefix/bin to PATH so your shell finds the dev command." ;;
  esac
  say 'Open a new terminal, then run dev from any Git project.'
}

main "$@" </dev/null
