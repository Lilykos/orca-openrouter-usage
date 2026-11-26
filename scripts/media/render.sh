#!/bin/sh
# Regenerates images/*.png from scripts/media/*.html with headless Chrome. Run from the repo root.
CH="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
shot() { "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=8000 "$@" >/dev/null 2>&1; }
R="file://$PWD/scripts/media"
shot --window-size=1600,1000 --screenshot=images/cover.png "$R/cover.html"
shot --default-background-color=00000000 --window-size=256,256 --screenshot=images/icon.png "$R/icon.html"
shot --window-size=1600,1000 --screenshot=images/screenshot-overview.png "$R/shot.html?t=Credits%2C%20budget%20and%20warnings&c=Balance%20and%20runway%20in%20the%20colour%20you%20pick%2C%20closable%20warnings%2C%20and%20today%20and%20this%20month%20against%20your%20budget.&h=dark,banner=gold,vivid,budget"
shot --window-size=1600,1000 --screenshot=images/screenshot-models.png "$R/shot.html?t=A%20day%2C%20its%20models%2C%20its%20tokens&c=Click%20a%20bar%20or%20a%20heatmap%20day%20and%20Models%20and%20Token%20mix%20switch%20to%20that%20day.&h=dark,open,pin=3,scroll=h-spend"
shot --window-size=1600,1000 --screenshot=images/screenshot-ledger.png "$R/shot.html?t=Token%20mix%20and%2026%20weeks%20of%20activity&c=Cache%20hits%2C%20prompt%20to%20output%20and%20reasoning%20as%20four%20numbers%2C%20over%20a%20calendar%20of%20every%20day%20you%20used.&h=dark,open,scroll=h-mix"
shot --window-size=1600,1000 --screenshot=images/screenshot-keys.png "$R/shot.html?t=Every%20key%2C%20with%20its%20own%20range&c=Spend%20per%20key%20for%207%20days%2C%2030%20days%20or%20all%20time%2C%20with%20limit%20meters%20and%20only%20the%20badges%20that%20matter.&h=light,tab=keys"
shot --window-size=1600,1000 --screenshot=images/screenshot-deepseek.png "$R/shot.html?t=DeepSeek%20balance%20too&c=Save%20a%20DeepSeek%20key%20in%20Settings%20and%20a%20card%20adds%20its%20balance%2C%20today%27s%20spend%20and%20days%20left.&h=light,deepseek,open"
shot --window-size=1600,1000 --screenshot=images/screenshot-settings.png "$R/shot.html?t=Your%20key%2C%20your%20rules&c=Account%2C%20banner%20colour%20with%20a%20live%20preview%2C%20alerts%2C%20budgets%2C%20the%20status%20bar%20and%20data%20options.&h=light,tab=settings,banner=teal,vivid"
