# Hermes Mobile for Linux Strix Halo

This package installs the mobile renderer beside an existing Hermes installation. It does not modify the Hermes checkout, `HERMES_HOME`, profiles, configuration, model credentials, or files.

## Requirements

1. Linux on x86_64.
2. Hermes CLI available on `PATH`.
3. Tailscale installed and signed in on the computer and iPhone.
4. A working user systemd session.
5. Hermes dashboard authentication already configured. Run `hermes dashboard register` before installation if needed.
6. The Python environment beside the Hermes executable must include `aiohttp`, `multidict`, and `yarl`.

## Install

Verify the release archive checksum before extraction. Then run:

```bash
./install
```

The installer prints a private Tailscale HTTPS address. Open it in iPhone Safari, sign in to Hermes, then use Share and Add to Home Screen.

Only one install, rollback, or uninstall operation can run at a time. The installer writes a durable transaction before changing services or Tailscale. If the computer loses power or the process is terminated, run the same command again. It recovers the interrupted operation before continuing.

Uploads are accepted up to 64 MiB. The upstream Hermes service may enforce a smaller limit.

## First field test

1. Confirm Hermes works locally before installation.
2. Install this exact archive and save the printed private URL.
3. Sign in from the phone and send one text conversation.
4. Upload one photo larger than 1 MiB, one short audio recording, and one small document.
5. Lock and unlock the phone, switch between Wi Fi and cellular, then confirm the conversation reconnects.
6. Reboot the computer and confirm the same private URL returns.
7. Run `./install` again to verify a same version reinstall.
8. Run `./uninstall`, confirm the URL stops responding, and confirm the existing Hermes installation still works.

If a command fails, rerun it once so durable recovery can complete. Service status is available with `systemctl --user status hermes-mobile-relay.service`. The installer never prints or stores dashboard passwords, cookies, model credentials, or Hermes files.

## Roll back

```bash
./rollback
```

## Uninstall

```bash
./uninstall
```

Uninstall removes only installer owned files and services. It removes the dedicated Tailscale Serve handler and verifies that all handlers that existed before installation remain unchanged.

## Security contract

The relay binds only to loopback. It accepts one fixed loopback Hermes upstream. It stores no dashboard username, password, cookie, token, or model credential. Installation fails before Tailscale exposure unless an unauthenticated sensitive Hermes route returns HTTP 401.
