#!/bin/sh
# Regenerates images/*.png from scripts/media/*.html with headless Chrome. Run from the repo root.
CH="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
shot() { "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=8000 "$@" >/dev/null 2>&1; }
R="file://$PWD/scripts/media"
shot --window-size=1600,1000 --screenshot=images/cover.png "$R/cover.html"
shot --default-background-color=00000000 --window-size=256,256 --screenshot=images/icon.png "$R/icon.html"
shot --window-size=1600,1000 --screenshot=images/screenshot-overview.png "$R/shot.html?t=Credits%20and%20budgets%2C%20at%20a%20glance&c=Credits%2C%20spend%20comparisons%20and%20monthly%20budget%20progress%2C%20with%20daily%20spend%20by%20model.&h=dark,budget"
shot --window-size=1600,1000 --screenshot=images/screenshot-models.png "$R/shot.html?t=See%20what%20each%20model%20costs&c=A%20ranked%20share%20of%20spend%20with%20a%20details%20drawer%20for%20every%20model.&h=dark,tab=models,drawer"
shot --window-size=1600,1000 --screenshot=images/screenshot-keys.png "$R/shot.html?t=Every%20key%2C%20with%20health%20and%20limits&c=Per-key%20spend%2C%20expiring%20keys%2C%20remaining%20allowance%20and%20UTC%20reset%20periods.&h=dark,tab=keys"
shot --window-size=1600,1000 --screenshot=images/screenshot-ledger.png "$R/shot.html?t=A%20daily%20ledger&c=Newest-first%20days%20with%20spend%2C%20plus%20an%20activity%20calendar.&h=dark,tab=ledger"
shot --window-size=1600,1000 --screenshot=images/screenshot-settings.png "$R/shot.html?t=Your%20key%2C%20your%20rules&c=Verify%20your%20management%20key%2C%20set%20alerts%20and%20choose%20what%20shows%20in%20the%20status%20bar.&h=dark,tab=settings"
