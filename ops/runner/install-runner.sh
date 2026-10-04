#!/usr/bin/env bash
# Install one more self-hosted GitHub Actions runner on this host, for one repo.
#
# Why one runner per repo: on a personal GitHub account a self-hosted runner
# is registered to exactly ONE repository, and a runner directory can only be
# configured once ("Cannot configure the runner because it is already
# configured"). Several runners can live side by side on the same host, each
# in its own directory with its own systemd service, all driving the same
# Docker daemon. This script creates such an instance.
#
# Usage (as the user that already runs your other runner, in the docker group):
#   ./install-runner.sh <owner/repo> <registration-token> [runner-name] [extra-labels]
#
# Get the registration token (valid 1 hour) from the repo:
#   Settings -> Actions -> Runners -> New self-hosted runner (the --token value)
# or with the GitHub CLI:
#   gh api -X POST repos/<owner/repo>/actions/runners/registration-token --jq .token
#
# Env:
#   RUNNERS_DIR     parent directory of the instances (default: ~/actions-runners)
#   RUNNER_VERSION  runner version, e.g. 2.328.0 (default: latest release)
set -euo pipefail

if [ $# -lt 2 ]; then
  sed -n '2,24p' "$0"
  exit 1
fi

REPO="$1"
TOKEN="$2"
NAME="${3:-$(hostname)-${REPO#*/}}"
LABELS="${4:-}"
BASE="${RUNNERS_DIR:-$HOME/actions-runners}"
DIR="$BASE/${REPO//\//__}"

if ! docker info >/dev/null 2>&1; then
  echo "error: '$(whoami)' cannot use Docker (add it to the docker group, then log in again)." >&2
  exit 1
fi

if [ -f "$DIR/.runner" ]; then
  echo "A runner is already configured for $REPO in $DIR."
  echo "To redo it: cd $DIR && sudo ./svc.sh stop && sudo ./svc.sh uninstall && ./config.sh remove --token <token>"
  exit 0
fi

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l) ARCH=arm ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

VERSION="${RUNNER_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
    | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$VERSION" ] || { echo "error: could not resolve the runner version" >&2; exit 1; }

echo "==> Installing runner v$VERSION for $REPO in $DIR (name: $NAME)"
mkdir -p "$DIR"
cd "$DIR"
curl -fsSL -o runner.tar.gz \
  "https://github.com/actions/runner/releases/download/v${VERSION}/actions-runner-linux-${ARCH}-${VERSION}.tar.gz"
tar xzf runner.tar.gz
rm runner.tar.gz

CONFIG_ARGS=(--unattended --url "https://github.com/$REPO" --token "$TOKEN" --name "$NAME" --work _work)
[ -n "$LABELS" ] && CONFIG_ARGS+=(--labels "$LABELS")
./config.sh "${CONFIG_ARGS[@]}"

# One systemd unit per instance (actions.runner.<owner>-<repo>.<name>.service).
sudo ./svc.sh install "$(whoami)"
sudo ./svc.sh start
sudo ./svc.sh status --no-pager || true

echo "==> Done. Runners on this host:"
ls -1 "$BASE"
