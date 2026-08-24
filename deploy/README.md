# Private Preview Deployment

This directory packages the mobile renderer and relay into a constrained private preview container.

## Runtime contract

1. Build only from the assembled release directory containing `dist/`, `server/`, and this `deploy/` directory.
2. Run with host networking only when the relay must reach a host dashboard on loopback or explicitly configured private nodes.
3. The process binds only to host loopback port 4176.
4. Publish only through a dedicated Tailscale Serve HTTPS port.
5. Preserve every existing Tailscale Serve handler.
6. The image contains no private node addresses. Add each trusted node at runtime with `--node name=https://private-node.example` and use `--read-only-node name` when that node should expose status only.

## Container constraints

Run as user 65532 with a read only root filesystem, all Linux capabilities dropped, `no-new-privileges`, a writable `/tmp` tmpfs, PID, memory, and CPU limits, and rotated logs.

## Health

The container health check reads only `/manifest.webmanifest`. Application acceptance still requires authenticated root, configured node HTTP and WebSocket checks, phone browser contracts, and unchanged existing Tailscale handlers.

## Rollback

Remove the dedicated Tailscale Serve port, stop and remove the preview container, and retain the previous immutable image and release archive until rollback verification completes.
