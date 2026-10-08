#!/bin/zsh
# one headless Chrome per shot, with a kill timer (shared profiles hang)
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd "${0:A:h}"
shot() { # opt screen w h
  P=$(mktemp -d)
  "$C" --headless=new --disable-gpu --hide-scrollbars --user-data-dir=$P --force-device-scale-factor=1 \
    --window-size=$3,$4 --screenshot=png/$1-$2.png "file://$PWD/index.html?opt=$1&screen=$2" >/dev/null 2>&1 &
  pid=$!; ( sleep 20; kill $pid 2>/dev/null ) & wait $pid; rm -rf $P
}
for o in A B C; do
  shot $o coin 1440 $([[ $o == C ]] && echo 1160 || echo 1000); shot $o home 1440 1000; shot $o golive 1440 900; shot $o overlay 1920 1080
done
