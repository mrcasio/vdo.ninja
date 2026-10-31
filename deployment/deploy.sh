#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
all_services=(turn-broker signaling frontend)

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [deploy|restart|status] [frontend|signaling|turn-broker ...]

  deploy   Build the selected images, then recreate their containers (default).
  restart  Recreate containers from the images already on the server.
  status   Show the current container status without changing anything.

Without service names, all three services are selected. Run this script on
vidivent2 from /var/lib/apps/vdo-ninja. It does not upload project files.
EOF
}

case "${1:-deploy}" in
  -h|--help) usage; exit 0 ;;
  deploy|restart|status) mode=${1:-deploy}; if (($#)); then shift; fi ;;
  *) usage >&2; exit 2 ;;
esac

if (($#)); then
  services=("$@")
else
  services=("${all_services[@]}")
fi
for service in "${services[@]}"; do
  case "$service" in
    frontend|signaling|turn-broker) ;;
    *) echo "Unknown service: $service" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$root" == /var/lib/apps/vdo-ninja ]] || {
  echo 'Run this script on vidivent2 from /var/lib/apps/vdo-ninja.' >&2
  exit 1
}
cd "$root"
docker compose config --quiet

if [[ "$mode" == status ]]; then
  docker compose ps "${services[@]}"
  exit 0
fi

[[ $EUID -eq 0 ]] || { echo 'Run as root so Nginx can be checked.' >&2; exit 1; }
nginx -t
python3 scripts/verify-public-source.py

for service in "${services[@]}"; do
  if [[ "$service" == frontend && ! -f src/index.html ]]; then
    echo 'Frontend source is missing. Prepare the pinned source before deploying.' >&2
    exit 1
  fi
done

if [[ "$mode" == deploy ]]; then
  docker compose build "${services[@]}"
fi

wait_healthy() {
  local service=$1 container state health
  for ((attempt=0; attempt<45; attempt++)); do
    container=$(docker compose ps --quiet "$service")
    if [[ -n "$container" ]]; then
      state=$(docker inspect --format '{{.State.Status}}' "$container")
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
      if [[ "$state" == running && "$health" == healthy ]]; then
        return 0
      fi
      if [[ "$state" == exited || "$state" == dead ]]; then
        break
      fi
    fi
    sleep 2
  done
  echo "$service did not become healthy; check: docker compose logs --tail=100 $service" >&2
  return 1
}

for service in "${services[@]}"; do
  docker compose up -d --no-deps --no-build --force-recreate "$service"
  wait_healthy "$service"
  echo "$service is healthy"
done

docker compose ps "${services[@]}"
