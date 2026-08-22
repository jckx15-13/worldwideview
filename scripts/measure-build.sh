#!/usr/bin/env bash
# Measure a Next.js production build: wall-clock + peak RSS across the whole
# process tree. Substitute for /usr/bin/time -v, which is not installed here.
# Identical method to the 2026-08-15 pre-merge baseline so numbers compare.
set -u
# Resolve both paths from the script's own location so the numbers are
# reproducible from any checkout, not just the machine that first ran this.
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$S/.." && pwd)"
cd "$REPO" || exit 1

# Pre-existing node/next PIDs are NOT part of this build. The original baseline
# script summed them in, which inflates peak RSS by whatever stray dev server or
# editor happens to be running. Snapshot them now and exclude them below.
PRE_PIDS=$(ps -eo pid=,args= 2>/dev/null | grep -E 'node|next-' | grep -v grep | awk '{print $1}' | sort -u)
PRE_KB=$(ps -eo rss=,args= 2>/dev/null | grep -E 'node|next-' | grep -v grep | awk '{s+=$1} END {print s+0}')
echo "PRE_EXISTING_NODE_RSS_MB=$((PRE_KB/1024))" > "$S/build.pre"
echo "PRE_EXISTING_NODE_PIDS=$(echo "$PRE_PIDS" | tr '\n' ' ')" >> "$S/build.pre"
cat "$S/build.pre"

START=$(date +%s)
NODE_OPTIONS="--max-old-space-size=6144" pnpm build > "$S/build.log" 2>&1 &
BPID=$!

PEAK_KB=0
PEAK_SYS_KB=0
while kill -0 "$BPID" 2>/dev/null; do
  # Sum RSS of node/next processes that did NOT exist before the build started.
  RSS=$(ps -eo pid=,rss=,args= 2>/dev/null \
        | grep -E 'node|next-' \
        | grep -v grep \
        | awk -v pre="$(echo "$PRE_PIDS" | tr '\n' ',')" '
            BEGIN { n=split(pre,a,","); for(i=1;i<=n;i++) skip[a[i]]=1 }
            !($1 in skip) { s+=$2 } END { print s+0 }')
  [ "${RSS:-0}" -gt "$PEAK_KB" ] && PEAK_KB=$RSS
  # System-wide used memory as a cross-check.
  SYS=$(free -k | awk 'NR==2{print $3}')
  [ "${SYS:-0}" -gt "$PEAK_SYS_KB" ] && PEAK_SYS_KB=$SYS
  sleep 2
done

wait "$BPID"; EXIT=$?
END=$(date +%s)

{
  echo "EXIT_CODE=$EXIT"
  echo "WALL_SECONDS=$((END-START))"
  echo "PEAK_NODE_RSS_MB=$((PEAK_KB/1024))"
  echo "PEAK_SYSTEM_USED_MB=$((PEAK_SYS_KB/1024))"
} > "$S/build.metrics"

cat "$S/build.metrics"
