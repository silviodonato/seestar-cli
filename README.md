# SeeStar CLI

A small local command-line controller for the SeeStar S50 at `192.168.8.24`.

## First-time setup

Firmware 7.18 and later requires an interoperability key from the official
SeeStar companion app. Place its PEM at `seestar.pem` alongside `seestar.js`,
or point `SEESTAR_KEY_PATH` at it. Keep that file private and do not commit or
share it.

## Commands

```bash
node seestar.js status
node seestar.js state
node seestar.js goto "M33 Triangulum Galaxy" 1.5639 30.6603
node seestar.js stack
node seestar.js stop
node seestar.js park
```

Use decimal RA hours and declination degrees for `goto`. The controller works
only over the local network; it never sends telescope information externally.
