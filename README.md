# .NET 10 passkeys behind a reverse proxy

The .NET 10 Blazor Web App template with Individual accounts ships passkey
registration and sign-in. When `IdentityPasskeyOptions.ServerDomain` isn't set,
Identity uses `Request.Host.Host` as the passkey's relying party ID (RP ID), the
domain the browser binds the passkey to. This repo puts the template behind a
YARP reverse proxy and shows what that does.

## What it proves

`npm run check` drives a real Chromium with a virtual authenticator (CDP
`WebAuthn.addVirtualAuthenticator`) and asserts:

1. **Direct** (`http://localhost:5292`): the unchanged template registers a
   passkey for RP ID `localhost` and signs in with it.
2. **Behind YARP, no fix** (`http://app.localhost:5100`): YARP sends the
   destination's host, so the app sees `Request.Host=127.0.0.1:5292` and
   offers RP ID `127.0.0.1`. Chromium refuses it:
   `SecurityError: The relying party ID is not a registrable domain suffix of, nor equal to the current domain.`
   No passkey is created. The template's error redirect also goes to
   `http://127.0.0.1:5292/...`, so the user lands logged out instead of on the error.
3. **Behind YARP, `ServerDomain = "app.localhost"` only**: the passkey is created
   and passkey sign-in works, but the redirect after registration is
   `Location: http://127.0.0.1:5292/Account/Manage/RenamePasskey/...`. The
   passkey is fixed; the app still isn't.
4. **Behind YARP, forwarded headers only** (`UseForwardedHeaders` with
   `XForwardedHost` and `AllowedHosts = app.localhost`): everything works, the
   app sees `Request.Host=app.localhost:5100`.
5. **Changing the value**: with the page on `login.app.localhost`, a passkey
   registered under `ServerDomain = "login.app.localhost"` stops working after a
   restart with `ServerDomain = "app.localhost"`. The page shows
   `Error: No passkey was provided by the authenticator.`, the console shows
   `NotAllowedError`, and the authenticator still holds the credential under
   the old RP ID.

## Run it

```
dotnet build PasskeysProxyDemo.slnx
cd check
npm install
npx playwright install chromium
npm run check
```

Ports 5292 (app) and 5100 (proxy) must be free. The check starts and stops
both processes itself, with a fresh SQLite database per scenario in a temp
folder it deletes at the end.

To try it by hand: run the app (`dotnet run --project src/PasskeyApp --launch-profile http`)
and the proxy (`dotnet run --project src/Proxy`), then open
`http://app.localhost:5100` in Chrome or Edge.

## What changed from the template

Only `src/PasskeyApp/Program.cs`, and the package versions:

- `builder.Services.Configure<IdentityPasskeyOptions>(builder.Configuration.GetSection("Passkeys"));`
  so `Passkeys:ServerDomain` comes from configuration
  (`Passkeys__ServerDomain` as an environment variable).
- `UseForwardedHeaders` behind the flag `Proxy:UseForwardedHeaders`, with
  `Proxy:AllowedHosts` copied into `ForwardedHeadersOptions.AllowedHosts`.
- `Database.Migrate()` on start, and one log line on the two passkey options
  endpoints (`Request.Host`, `ServerDomain`, `Origin`). Both are demo-only.
- The template pins its EF Core and Identity packages at 10.0.5, which pulls a
  `SQLitePCLRaw.lib.e_sqlite3` with a high-severity advisory (NU1903). They are
  bumped to 10.0.14 here.

In production you'd put the value in `appsettings.Production.json` or the
environment:

```json
{
  "Passkeys": { "ServerDomain": "app.example.com" }
}
```

## Versions

- .NET SDK 10.0.201 (pinned in `global.json`), ASP.NET Core runtime 10.0.5.
  The passkey code that runs is the shared framework's, so 10.0.5.
- Microsoft.AspNetCore.Identity.EntityFrameworkCore, EF Core SQLite and the
  other template packages 10.0.14.
- Yarp.ReverseProxy 2.3.0.
- Playwright 1.64.1 with its headless Chromium 156.0.8078.4, Node 26.1.0.
- Windows 11.

## Edge cases the post leaves out

- **Origin check.** Identity's default origin validation compares the
  `origin` in the client data with the request's `Origin` header, and rejects
  cross-origin iframes. It doesn't look at `Host`, so it passed in every
  scenario here. Both values come from the browser; a proxy that strips or
  rewrites `Origin` would break it. `IdentityPasskeyOptions.ValidateOrigin` lets
  you replace it with your own list of allowed origins.
- **HTTP.** The demo runs on plain HTTP because Chromium treats `localhost` and
  `*.localhost` as secure contexts. Real deployments need HTTPS; the docs say
  all passkey operations require it.
- **`localhost` as a parent.** On `app.localhost`, Chromium refuses RP ID
  `localhost` (it treats it like a public suffix and then tries the
  `.well-known/webauthn` related-origins file). That is why the "change the
  value" scenario uses `login.app.localhost` and its parent `app.localhost`.
- **Conditional (autofill) sign-in.** The template's login page starts a
  conditional passkey request on load. The virtual authenticator answers it by
  itself, which races the script, so the check turns it off with an init script
  and always signs in through the "Log in with a passkey" button.
- **Forwarded headers from a non-loopback proxy.** `ForwardedHeadersOptions`
  trusts only loopback proxies by default. The proxy here is on loopback; in
  containers it usually isn't, and you have to add it to `KnownProxies` or
  `KnownIPNetworks`, or the headers are ignored without an error.
- **Preserving Host in the proxy instead.** YARP can send the original Host
  (`RequestHeaderOriginalHost`), and so can nginx (`proxy_set_header Host $host`).
  That fixes the app the same way forwarded headers do. Not tested here.
- **Server log.** When the browser refuses the RP ID, Identity logs nothing at the template's log levels:
  the request for options succeeded, and no credential ever comes back. The
  only server-side trace in this demo is its own log line.

## License

MIT
