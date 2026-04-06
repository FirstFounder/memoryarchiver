!/bin/sh
cd ~/code/memoryarchiver
git push
ssh -i ~/.ssh/joc517 philander@192.168.106.6 ". ~/.profile && cd ~/memoryarchiver && ./deploy.sh"
