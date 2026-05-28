#!/usr/bin/env bash
set -euo pipefail

ssh-keygen -A
mkdir -p /run/sshd

exec /usr/sbin/sshd -D -e
