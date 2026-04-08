#!/bin/sh
cd ~/code/memoryarchiver
git push
ssh philander@192.168.21.6 -p 9932 ". ~/.profile && cd ~/memoryarchiver && ./deploy.sh"
