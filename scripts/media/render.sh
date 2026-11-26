#!/bin/sh
# Regenerates images/*.png from scripts/media/*.html with headless Chrome. Run from the repo root.
CH="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
shot() { "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=8000 "$@" >/dev/null 2>&1; }
R="file://$PWD/scripts/media"
shot --window-size=1600,1000 --screenshot=images/cover.png "$R/cover.html"
shot --default-background-color=00000000 --window-size=256,256 --screenshot=images/icon.png "$R/icon.html"
shot --window-size=1600,1000 --screenshot=images/screenshot-overview.png "$R/shot.html?t=Credits%20first%2C%20detail%20on%20demand&c=Credits%20and%20runway%20up%20top%2C%20warnings%20you%20can%20close%2C%20and%20daily%20spend%20you%20can%20point%20at.&h=dark,budget"
shot --window-size=1600,1000 --screenshot=images/screenshot-models.png "$R/shot.html?t=A%20day%2C%20its%20models%2C%20its%20tokens&c=Pick%20a%20bar%20or%20a%20heatmap%20day%20to%20see%20every%20model%20and%20the%20token%20mix%20for%20it.&h=dark,pin=3,scroll=h-spend"
shot --window-size=1600,1000 --screenshot=images/screenshot-keys.png "$R/shot.html?t=Every%20key%2C%20with%20its%20own%20range&c=Spend%20per%20key%20for%207%20days%2C%2030%20days%20or%20all%20time%2C%20with%20limits%20and%20only%20the%20badges%20that%20matter.&h=dark,tab=keys"
shot --window-size=1600,1000 --screenshot=images/screenshot-ledger.png "$R/shot.html?t=Token%20mix%20and%2026%20weeks%20of%20activity&c=Cache%20hits%20and%20prompt%20to%20output%20at%20a%20glance%2C%20plus%20a%20calendar%20of%20every%20day%20you%20used.&h=dark,scroll=h-mix"
shot --window-size=1600,1000 --screenshot=images/screenshot-settings.png "$R/shot.html?t=Your%20key%2C%20your%20rules&c=Verify%20your%20management%20key%2C%20set%20alerts%20and%20budgets%2C%20and%20choose%20what%20the%20status%20bar%20shows.&h=light,tab=settings"
