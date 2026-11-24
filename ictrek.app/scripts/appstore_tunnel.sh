#!/usr/bin/env bash
set -euo pipefail
socket="${RUNNER_TEMP:?}/vos-appstore-ssh.sock"
case "${1:-}" in
  open)
    test -n "${APPSTORE_IP:-}"
    test -n "${APPSTORE_TOKEN:-}"
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    ssh-keyscan -T 15 -H -p 32222 "$APPSTORE_IP" >> "$HOME/.ssh/known_hosts"
    askpass="$RUNNER_TEMP/vos-appstore-askpass.sh"
    cat > "$askpass" <<'EOF'
#!/bin/sh
printf '%s\n' "$APPSTORE_TOKEN"
EOF
    chmod 700 "$askpass"
    export SSH_ASKPASS="$askpass" SSH_ASKPASS_REQUIRE=force DISPLAY=:0
    ssh -M -S "$socket" -f -N -L 18899:127.0.0.1:18090 -p 32222 \
      -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o BatchMode=no -o ExitOnForwardFailure=yes -o PreferredAuthentications=password \
      -o PubkeyAuthentication=no tunneluser@"$APPSTORE_IP" </dev/null
    for _ in $(seq 1 20); do
      if curl -fsS --max-time 5 http://127.0.0.1:18899/api/health >/dev/null; then
        echo 'VOS_DEPENDENCY_CATALOG_URL=http://127.0.0.1:18899' >> "${GITHUB_ENV:?}"
        exit 0
      fi
      sleep 1
    done
    echo 'App Store tunnel health check failed' >&2
    exit 1
    ;;
  close)
    ssh -S "$socket" -O exit -p 32222 tunneluser@"${APPSTORE_IP:?}" >/dev/null 2>&1 || true
    ;;
  *) echo 'Usage: appstore_tunnel.sh open|close' >&2; exit 1 ;;
esac
