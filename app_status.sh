#!/usr/bin/env python3
import json, subprocess, re, sys

try:
    with open('/var/lib/coopdoor/state.json') as f:
        state = json.load(f)
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(0)

scheduler_result = subprocess.run(
    ['systemctl', 'is-active', 'coopdoor.service'],
    capture_output=True, text=True
)
scheduler_active = scheduler_result.stdout.strip() == 'active'

try:
    sched_src = open('/opt/coopdoor/door_scheduler.py').read()
    open_at  = (re.search(r"OPEN_AT\s*=\s*['\"]([^'\"]+)", sched_src) or [None,''])[1]
    close_at = (re.search(r"CLOSE_AT\s*=\s*['\"]([^'\"]+)", sched_src) or [None,''])[1]
except Exception:
    open_at = ''
    close_at = ''

state.update({
    'schedulerActive': scheduler_active,
    'openAt':  open_at,
    'closeAt': close_at,
})
print(json.dumps(state))
