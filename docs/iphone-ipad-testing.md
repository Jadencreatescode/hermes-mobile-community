# iPhone and iPad testing

Hermes Mobile is an installable web app for Safari. It is not an App Store binary and does not require the private Hermes Owner application.

## Compatibility

Hermes Mobile is a thin client. Conversations, Messaging, Bot Mode, models, voice, files, browser features, profiles, cron, and updates remain owned by the connected Hermes backend.

For complete feature parity, use the mobile renderer and backend from the same public release, or use a newer backend. If the backend predates the renderer, the shell may load while newer Bot Mode, profile, session, file, or messaging methods remain unavailable.

Before testing a new public mobile release:

1. Update the public Hermes installation or checkout.
2. Restart the Hermes gateway through the installation's normal service route.
3. Update or restart the Hermes Mobile relay.
4. Open the mobile URL in Safari and accept the waiting app update when prompted.

A tester does not need the private Owner edition or any private Owner credentials.

## Install on iPhone or iPad

1. Open the private HTTPS Hermes Mobile URL in Safari.
2. Sign in to the connected Hermes backend.
3. Use Safari's Share menu and choose **Add to Home Screen**.
4. Launch Hermes Mobile from the new icon.
5. Keep the URL private. The relay is a private interface to the tester's own Hermes installation, not a public hosted account.

## Acceptance checklist

1. Confirm the shell clears the status bar, notch, Dynamic Island, and home indicator in portrait and landscape.
2. Confirm the keyboard shortens the conversation without covering the composer.
3. Open the Sessions rail, resume a conversation, and send one text turn.
4. Open Bot Mode, select a bot, and complete one bot conversation.
5. Open Messaging and confirm the connected platform list loads.
6. Record and send one short voice message.
7. Play one returned audio clip and one video clip.
8. Upload one image and one document within the 64 MB boundary.
9. Lock and unlock the device, then confirm the active conversation reconnects.
10. Switch between Wi Fi and cellular service and confirm the conversation recovers.
11. When an update prompt appears, accept it once and confirm the app reloads into the same private origin.

## Public and private boundaries

The public mobile release includes the shareable renderer, relay, PWA assets, responsive layouts, Bot Mode, Messaging, voice, files, model controls, and update flow.

It excludes private Owner Operations, private node addresses, Android native bridges, SMS access, Watch brokerage, credentials, deployment state, and private release history.
