
## Git Rules
- Always commit directly to main. Never create a branch.
- Never use git worktrees.
- After committing, stop. Do not push unless explicitly asked.

## Deployment
- Never deploy. After a requested push, the user runs `/volume1/homes/philander/bin/update-memoryarchiver.sh` as root on each host. See README "Deployment".
- Production runs as root without pm2; don't start or restart the app as philander.
