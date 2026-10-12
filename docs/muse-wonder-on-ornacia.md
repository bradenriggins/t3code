# Muse Wonder on Ornacia

This page is for the Linux machine that runs T3 Code nightly `0.0.46-nightly.20261010.2935` and Muse Code `1.4.6-R6000.1`.

Muse Code is installed with Meta's launcher at `~/.local/bin/muse`. The launcher runs `~/.local/bin/.muse-bin`. The active version is in `.muse-version`.

## What already works

T3 Code reads models from Muse Code. It asks `muse serve` for `model/list`. It does not store a fixed Wonder id.

[Meta's model page](https://dev.meta.ai/docs/models) names the standard model `muse-wonder-1.0`. That page also says:

- Muse Wonder is in Muse Code on every plan, and on the Model API.
- Muse Wonder Full is only in Muse Code, on the Power Usage and Maximum Usage plans.
- A reasoning effort of `max` does not select Muse Wonder Full.
- Wonder accepts text, image, video, audio, and PDF input.
- The context window is 1,048,576 tokens.
- Reasoning effort runs from `minimal` to `max`.

Muse Code 1.4.6 does not embed a Wonder model id in the binary. A logged-out `model/list` returns an empty bundled catalog (`source: bundledCatalog`). The signed-in provider catalog is the list T3 Code shows. Full appears when that catalog contains a Full row.

Each row includes `variants`. T3 Code shows those efforts in the reasoning control. The labels are None, Minimal, Low, Medium, High, Extra High, Max, and Ultra. An effort the row does not list is not sent.

T3 Code sends image attachments to Muse as image parts. The catalog has no per-model image flag. Video, audio, and PDF stay as file paths in the prompt text.

Contributor mode is a Muse host setting (`--contributor-mode` on one run, or the saved Muse setting). T3 Code does not send that flag. `muse serve` uses the saved setting. Spark can also appear as its own row, such as `muse-spark-1.3-contributor`. A Wonder contributor row appears the same way when Muse lists it.

## Which build has Muse 1.4.6 support

The running nightly `20261010.2935` does not contain commit `6ba6a0daf`.

That commit is pull request [#18409](https://github.com/pingdotgg/t3code/pull/18409), "fix(provider-muse): run on Muse 1.4.6". It landed on 11 Oct 2026.

The first nightly tag that contains it is `v0.0.46-nightly.20261012.3010`.

The newest nightly tag on 12 Oct 2026 is `v0.0.46-nightly.20261012.3021`.

Use `0.0.46-nightly.20261012.3021` or a newer nightly. That build lists every model Muse returns, including Wonder and Full when the account can see them.

This fork adds one more behavior on top of current `main`. It keeps each row's `contextLimit` and gives that number to the context meter. A later `session/contextUsage` value replaces it when Muse sends `windowTokens`.

## Update the desktop app and keep one server

Threads, projects, and settings stay in `~/.t3/userdata`. An update does not delete that directory.

One T3 server listens on port 3773. A second `t3 serve` fails or splits state. Do not start one.

1. Finish or stop active agent turns.
2. Find the listener:

   ```sh
   ss -H -ltnp 'sport = :3773'
   ```

3. Read the executable path from that line. The current server is:

   `~/.t3/runtime/versions/0.0.46-nightly.20261010.2935/t3`

4. Update that runtime. Run this in a terminal on the same machine:

   ```sh
   t3 update 0.0.46-nightly.20261012.3021
   ```

   `t3 update --channel nightly` installs the newest nightly instead of this pin. The command asks before it restarts a background service. Answer yes when no other T3 server is running.

5. Update the desktop app to the same nightly. Use the update control in the nightly desktop app, or install this package from GitHub release `v0.0.46-nightly.20261012.3021`:

   `T3-Code-0.0.46-nightly.20261012.3021-amd64.deb`

6. Open the desktop app. It uses the server on port 3773. Do not run `t3 serve` in another terminal.
7. Repeat the `ss` command. One process listens on port 3773.

If two processes listen, stop the process you started by hand. Keep the desktop app or the background service. Do not use `pkill`.

## Select Wonder and its variants

1. Open **Settings → Providers**. Select this environment.
2. Enable **Muse Code**.
3. Set **Binary path** to `~/.local/bin/muse` when the status check cannot find `muse`.
4. Refresh provider status.
5. Open a thread. Open the model picker. Choose **Muse Code**.
6. Choose the Wonder row. The label is the catalog `displayLabel`. The id T3 Code sends is the catalog `modelId`. Meta's docs name the standard row `muse-wonder-1.0`.
7. Open the reasoning control. Choose an effort from that row. The control lists only the efforts Muse sent for that model.
8. When Muse Wonder Full is missing, the signed-in catalog has no Full row. Full needs a Power Usage or Maximum Usage plan. Change the plan in Muse, then refresh provider status.
9. To change contributor mode, change it in Muse Code, then refresh provider status. T3 Code picks up new catalog rows on that refresh.

## Build the patched desktop app from this fork

Use these steps when you want the context-window change before a nightly contains it.

1. Stop the server that listens on port 3773. Leave `~/.t3/userdata` in place.
2. Clone this fork and check out the pull request branch.
3. Install Node.js 24.13.1. In the repo, run `vp i`.
4. Run `vp run build:desktop`.
5. Launch that desktop build. It uses `~/.t3` by default, so existing threads stay available.
6. Leave the old runtime stopped:

   `~/.t3/runtime/versions/0.0.46-nightly.20261010.2935/t3`

7. Confirm port 3773 has one listener.

## Verification

1. `muse --version` prints `Muse Code 1.4.6 (1.4.6-R6000.1)`.
2. Port 3773 has one listener.
3. The T3 server version is `0.0.46-nightly.20261012.3010` or newer, or the desktop build from this fork.
4. **Settings → Providers** shows Muse Code ready after a refresh.
5. The model picker lists Muse Wonder.
6. When the account includes Full, the picker lists that row too.
7. The reasoning control lists the efforts for the selected row.
8. A short text prompt completes.
9. An image attachment completes.
10. The context meter shows a window. Wonder's documented size is 1,048,576 tokens when Muse reports that `contextLimit`.
11. Older threads are still in the sidebar.

## Rollback

1. Stop the new server. Leave `~/.t3/userdata` in place.
2. Restore the previous runtime:

   ```sh
   t3 update 0.0.46-nightly.20261010.2935 --allow-downgrade
   ```

3. When you replaced the desktop package, install `T3-Code-0.0.46-nightly.20261010.2935-amd64.deb` from release `v0.0.46-nightly.20261010.2935`.
4. Start one server. Confirm port 3773 has one listener.
5. Nightly `20261010.2935` does not contain the Muse 1.4.6 fix. Turns on Muse Code 1.4.6 can fail on that build.
