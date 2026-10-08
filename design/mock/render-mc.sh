#!/bin/zsh
# one headless Chrome per shot, with a kill timer; virtual time lets Google Fonts load
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd "${0:A:h}"
shot() { # opt screen w h
  P=$(mktemp -d)
  "$C" --headless=new --disable-gpu --hide-scrollbars --user-data-dir=$P --force-device-scale-factor=1 \
    --virtual-time-budget=8000 --window-size=$3,$4 --screenshot=mc/$1-$2.png "file://$PWD/mc.html?opt=$1&screen=$2" >/dev/null 2>&1 &
  pid=$!; ( sleep 30; kill $pid 2>/dev/null ) & wait $pid; rm -rf $P
}
for o in ${@:-A B C}; do
  shot $o coin 1440 1240; shot $o home 1440 1080; shot $o golive 1440 960
done
