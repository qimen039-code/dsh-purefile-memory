#!/bin/bash
# LoCoMo server keep-alive loop for SCNet (survives session exits via setsid).
while true; do
  if ! pgrep -f 'python /root/loco_server.py' > /dev/null; then
    echo "[$(date)] restarting" >> /root/loco_keep.log
    export DTK_HOME=/opt/dtk-26.04
    . /opt/hyhal/env.sh 2>/dev/null
    . /opt/dtk-26.04/env.sh 2>/dev/null
    cd /root
    python /root/loco_server.py >> /root/loco_server.log 2>&1
  fi
  sleep 10
done
