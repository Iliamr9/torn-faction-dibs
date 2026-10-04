# Torn Faction Dibs

A Tampermonkey userscript for coordinating faction-war targets in Torn.

## What it does

- Detects `dibs` in faction chat case-insensitively (`dibs`, `DIBS`, `Dibs`, etc.).
- Associates the caller with the target named in the same chat message.
- Shows active dibs directly in faction member lists and on player profiles.
- First claim on a target wins.
- If a player calls dibs on a new free target, their old claim is released and moved to the new target.
- Re-reads the latest 50 faction-chat messages during checks so missed messages can be recovered.
- Clears dibs when the target is detected as defeated/fallen according to the script's attack/status logic.
- Synchronizes state between open Torn tabs.
- Stores each user's Torn API key locally in their own userscript storage. No API key is included in this repository.

## Install

1. Install Tampermonkey in your browser.
2. Open the install link: https://raw.githubusercontent.com/Iliamr9/torn-faction-dibs/main/torn-faction-dibs.user.js
3. Tampermonkey should show an installation screen. Install the script.
4. Refresh Torn.
5. Open the DIBS panel and add your own Torn API key if required by the features you use.

If your browser does not hand `.user.js` files directly to Tampermonkey, create a new script in Tampermonkey, replace the default contents with the raw script contents, and save.

## Share with your faction

Send faction members this one install link:

https://raw.githubusercontent.com/Iliamr9/torn-faction-dibs/main/torn-faction-dibs.user.js

They install it once. Future releases are delivered through Tampermonkey using the script's `@updateURL`; they should not install a second copy for each version.

## Updating

Tampermonkey checks the script's `@updateURL`. When a release is published, the maintainer must:

1. Change both the userscript `@version` and the internal `VERSION` constant.
2. Commit the updated `torn-faction-dibs.user.js` to the `main` branch.
3. Users can wait for Tampermonkey's normal update check or use **Tampermonkey → Check for userscript updates**.

Do not rename the main userscript file after distribution, because the update URL depends on its stable path.

## Dibs format

Examples that should be recognized include:

```text
dibs TargetName
TargetName dibs
dibs TargetName [1234567]
DIBS TargetName [1234567]
```

The target name/ID must appear in the same chat message as `dibs`.

## Important

Only run **one generation of Torn Faction Dibs at a time**. Disable or delete older experimental versions before installing this release; running several generations simultaneously can make claims appear, disappear, or overwrite one another unexpectedly.

## Privacy

The script does not ship with a Torn API key. Each faction member enters their own key locally. Never commit personal API keys to this repository.

## License

MIT. See `LICENSE`.
