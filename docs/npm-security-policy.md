# NPM security policy

Hermes Mobile treats dependency advisories according to the code that ships and the paths the product actually executes.

## Blocking gate

Every mobile change must pass:

```bash
npm run audit:mobile
```

This evaluates the complete root audit, blocks every unknown advisory, and permits only the exact reviewed Electron development findings below while they remain development only at the reviewed versions. The website lockfile must also report zero known vulnerabilities.

## Electron development exceptions

The full development audit still reports Electron 40.10.2 and its installer dependency, extract-zip 2.0.1. These are retained deliberately until the supported Windows installation route can move safely.

### GHSA-9f4c-93c8-jc8g

Electron 40 can let sandboxed frames reach `setWindowOpenHandler` without a user gesture. Hermes renders untrusted artifact HTML in sandboxed frames, so this advisory matters.

The application closes the vulnerable route in `apps/desktop/electron/window-open-policy.ts`. Every request is denied and the handler never opens a URL as a side effect. Trusted links use the separately validated external link bridge. `tests-js/window-open-policy.test.ts` protects this contract.

### GHSA-r4w5-6pfg-jxp5

This advisory requires `ProtocolResponse.url` without an explicit session while relying on separate Electron session partitions. Hermes registers the media protocol with `protocol.handle()` and returns `Response` objects. It does not use the affected response shape or that isolation model.

### GHSA-jmr9-qjv8-65gv

`extract-zip` does not validate malicious symbolic link targets. It is used only by Electron's development installation path and has no patched upstream release. The archive is selected by the pinned Electron package and checked through npm lockfile integrity.

Electron 40.10.3 and later replace this JavaScript extractor with a native Microsoft Visual C++ binding. Nous Research reverted that upgrade after confirmed fresh Windows installation failures on machines without the Visual C++ Redistributable. Moving to Electron 41 would remove the audit finding but restore that field failure.

Electron issue 52481 closed after Electron 43 and later learned to delay loading the native extractor and report its failures accurately. Those changes let an already installed or externally supplied Electron distribution bypass extraction. They do not provide a JavaScript fallback for the first fresh extraction under Windows Smart App Control, so they do not yet close this installation requirement.

## Upgrade rule

Reconsider the Electron pin when either condition becomes true:

1. Electron publishes a supported extraction path that works on fresh Windows without an undeclared runtime.
2. The installer explicitly provisions and verifies the required Windows runtime before npm installation.

Any Electron change must preserve the exact dependency pin, `build.electronVersion`, the root `allowScripts` entry, clean Windows installation, and the window opening security contract.
